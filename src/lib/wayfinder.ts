/**
 * AR.IO Wayfinder integration for resilient Arweave data access.
 *
 * Uses FastestPingRoutingStrategy (recommended for most permaweb apps) to pick
 * the lowest-latency AR.IO gateway that has the requested data, with static
 * path-style fallbacks when sandbox routing is unavailable.
 *
 * @see https://github.com/ar-io/wayfinder
 */
import {
  CompositeGatewaysProvider,
  CompositeRoutingStrategy,
  FastestPingRoutingStrategy,
  RandomRoutingStrategy,
  SimpleCacheGatewaysProvider,
  StaticGatewaysProvider,
  TrustedPeersGatewaysProvider,
  createWayfinderClient,
  type Wayfinder,
} from '@ar.io/wayfinder-core';
import {
  ARWEAVE_PUBLIC_DATA_GATEWAY_BASES,
  ARWEAVE_RELIABLE_DATA_GATEWAY_BASES,
  normalizeArweaveTxId,
  preferredArweaveStreamUrl,
} from './arweaveDataGateway';

const WAYFINDER_PING_TIMEOUT_MS = 1_500;
const PATH_STYLE_PING_TIMEOUT_MS = 2_000;
const RESOLVE_CACHE_TTL_MS = 5 * 60_000;
const GATEWAY_CACHE_TTL_SECONDS = 300;

const resolveCache = new Map<string, { url: string; expiresAt: number }>();

let wayfinderClient: Wayfinder | null = null;
let wayfinderInitFailed = false;

function staticGatewayUrls(): string[] {
  return [...ARWEAVE_RELIABLE_DATA_GATEWAY_BASES, ...ARWEAVE_PUBLIC_DATA_GATEWAY_BASES].filter(
    (url, index, all) => all.indexOf(url) === index
  );
}

/** Sandbox / path URLs on hosts that often hang after redirect without a VPN. */
function isUnreliableGatewayUrl(url: string): boolean {
  return /(?:^|\/\/)(?:[^/]*\.)?(?:ar-io\.dev|permagate\.io)(?:[:/]|$)/i.test(url);
}

function demoteUnreliableGatewayUrls(urls: string[]): string[] {
  const reliable: string[] = [];
  const unreliable: string[] = [];
  for (const url of urls) {
    if (isUnreliableGatewayUrl(url)) unreliable.push(url);
    else if (!reliable.includes(url)) reliable.push(url);
  }
  for (const url of unreliable) {
    if (!reliable.includes(url)) reliable.push(url);
  }
  return reliable;
}

function getWayfinderClient(): Wayfinder | null {
  if (wayfinderInitFailed) return null;
  if (wayfinderClient) return wayfinderClient;

  try {
    const gatewaysProvider = new SimpleCacheGatewaysProvider({
      ttlSeconds: GATEWAY_CACHE_TTL_SECONDS,
      gatewaysProvider: new CompositeGatewaysProvider({
        providers: [
          new TrustedPeersGatewaysProvider({
            trustedGateway: 'https://turbo-gateway.com',
          }),
          new StaticGatewaysProvider({
            gateways: staticGatewayUrls(),
          }),
        ],
      }),
    });

    // FastestPing first (HEAD probe for the tx), then random AR.IO peer if pings fail.
    const strategy = new CompositeRoutingStrategy({
      strategies: [
        new FastestPingRoutingStrategy({
          timeoutMs: WAYFINDER_PING_TIMEOUT_MS,
          gatewaysProvider,
        }),
        new RandomRoutingStrategy({
          gatewaysProvider,
        }),
      ],
    });

    wayfinderClient = createWayfinderClient({
      routingSettings: { strategy },
    });
    return wayfinderClient;
  } catch {
    wayfinderInitFailed = true;
    return null;
  }
}

function cacheResolvedUrl(txId: string, url: string) {
  resolveCache.set(txId, { url, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
}

function readCachedUrl(txId: string): string | null {
  const hit = resolveCache.get(txId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    resolveCache.delete(txId);
    return null;
  }
  return hit.url;
}

/**
 * Path-style FastestPing: Range-GET `/{txId}` on each static gateway (no AR.IO sandbox subdomain).
 * Used when Wayfinder sandbox routing fails (common on non-AR.IO hosts).
 */
async function resolvePathStyleFastest(txId: string): Promise<string | null> {
  const id = normalizeArweaveTxId(txId);
  if (!id) return null;

  return await new Promise<string | null>((resolve) => {
    let pending = ARWEAVE_RELIABLE_DATA_GATEWAY_BASES.length;
    let settled = false;

    for (const base of ARWEAVE_RELIABLE_DATA_GATEWAY_BASES) {
      const url = `${base}/${id}`;
      void fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(PATH_STYLE_PING_TIMEOUT_MS),
      })
        .then((response) => {
          if (!settled && (response.ok || response.status === 206)) {
            settled = true;
            resolve(url);
          }
        })
        .catch(() => {})
        .finally(() => {
          pending -= 1;
          if (!settled && pending === 0) resolve(null);
        });
    }
  });
}

async function resolveViaWayfinder(txId: string): Promise<string | null> {
  const client = getWayfinderClient();
  if (!client) return null;
  try {
    const url = await client.resolveUrl({ txId });
    return String(url);
  } catch {
    return null;
  }
}

/**
 * Resolve the best data URL for a tx id via Wayfinder (FastestPing), then path-style ping,
 * then static Turbo/permagate defaults.
 */
export async function resolveWayfinderDataUrl(txId: string): Promise<string> {
  const id = normalizeArweaveTxId(txId);
  if (!id) return preferredArweaveStreamUrl(txId);

  const cached = readCachedUrl(id);
  if (cached) return cached;

  const wayfinderUrl = await resolveViaWayfinder(id);
  if (wayfinderUrl && !isUnreliableGatewayUrl(wayfinderUrl)) {
    cacheResolvedUrl(id, wayfinderUrl);
    return wayfinderUrl;
  }

  const pathStyleUrl = await resolvePathStyleFastest(id);
  if (pathStyleUrl) {
    cacheResolvedUrl(id, pathStyleUrl);
    return pathStyleUrl;
  }

  return preferredArweaveStreamUrl(id);
}

/**
 * Ordered candidate URLs: Wayfinder winner first, then static public gateways.
 * Safe for `<img onError>` / audio error fallback chains.
 */
export async function resolveWayfinderDataUrls(txId: string): Promise<string[]> {
  const id = normalizeArweaveTxId(txId);
  const primary = await resolveWayfinderDataUrl(id);
  const urls = [primary];
  for (const base of ARWEAVE_PUBLIC_DATA_GATEWAY_BASES) {
    const url = `${base}/${id}`;
    if (!urls.includes(url)) urls.push(url);
  }
  return demoteUnreliableGatewayUrls(urls);
}

/** Warm the gateway peer list in the background (call once on app start). */
export function warmWayfinderGateways(): void {
  void getWayfinderClient();
}
