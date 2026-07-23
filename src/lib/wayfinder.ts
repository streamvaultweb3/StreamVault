/**
 * Resilient Arweave data URL resolution without probing the full AR.IO peer network.
 *
 * Uses path-style Range probes on a small curated gateway list instead of @ar.io/wayfinder-core
 * FastestPing, which HEAD-pings every trusted peer and floods the console/network when many
 * artworks load at once.
 */
import {
  ARWEAVE_PUBLIC_DATA_GATEWAY_BASES,
  ARWEAVE_RELIABLE_DATA_GATEWAY_BASES,
  isArweaveSandboxGatewayUrl,
  normalizeArweaveTxId,
  preferredArweaveStreamUrl,
} from './arweaveDataGateway';

const PATH_STYLE_PING_TIMEOUT_MS = 2_000;
const RESOLVE_CACHE_TTL_MS = 5 * 60_000;

const resolveCache = new Map<string, { url: string; expiresAt: number }>();
const resolveInflight = new Map<string, Promise<string[]>>();

/** Sandbox / path URLs on hosts that often hang after redirect without a VPN. */
function isUnreliableGatewayUrl(url: string): boolean {
  return (
    isArweaveSandboxGatewayUrl(url) ||
    /(?:^|\/\/)(?:[^/]*\.)?(?:ar-io\.dev|permagate\.io)(?:[:/]|$)/i.test(url)
  );
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

function cacheResolvedUrl(txId: string, url: string) {
  if (isUnreliableGatewayUrl(url)) return;
  resolveCache.set(txId, { url, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
}

function readCachedUrl(txId: string): string | null {
  const hit = resolveCache.get(txId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    resolveCache.delete(txId);
    return null;
  }
  if (isUnreliableGatewayUrl(hit.url)) {
    resolveCache.delete(txId);
    return null;
  }
  return hit.url;
}

function pathStyleDataUrl(base: string, txId: string): string {
  return `${base.replace(/\/+$/, '')}/${txId}`;
}

function appendPublicGatewayUrls(txId: string, urls: string[]): string[] {
  const merged = [...urls];
  for (const base of ARWEAVE_PUBLIC_DATA_GATEWAY_BASES) {
    const url = pathStyleDataUrl(base, txId);
    if (!merged.includes(url)) merged.push(url);
  }
  return demoteUnreliableGatewayUrls(merged);
}

/**
 * Path-style probe: Range-GET `/{txId}` on curated gateways.
 * Never follows redirects to sandbox subdomains — always keeps path-style on the curated base.
 */
async function resolvePathStyleFastest(txId: string): Promise<string | null> {
  const id = normalizeArweaveTxId(txId);
  if (!id) return null;

  return await new Promise<string | null>((resolve) => {
    let pending = ARWEAVE_RELIABLE_DATA_GATEWAY_BASES.length;
    let settled = false;

    for (const base of ARWEAVE_RELIABLE_DATA_GATEWAY_BASES) {
      const url = pathStyleDataUrl(base, id);
      void fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(PATH_STYLE_PING_TIMEOUT_MS),
      })
        .then((response) => {
          if (
            !settled &&
            (response.ok ||
              response.status === 206 ||
              response.status === 302 ||
              response.status === 307)
          ) {
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

async function resolveWayfinderDataUrlsInternal(txId: string): Promise<string[]> {
  const id = normalizeArweaveTxId(txId);
  if (!id) return [preferredArweaveStreamUrl(txId)];

  const cached = readCachedUrl(id);
  const urls: string[] = [];
  if (cached) urls.push(cached);

  const pathStyleUrl = await resolvePathStyleFastest(id);
  if (pathStyleUrl) {
    cacheResolvedUrl(id, pathStyleUrl);
    if (!urls.includes(pathStyleUrl)) urls.unshift(pathStyleUrl);
  }

  if (urls.length === 0) {
    urls.push(preferredArweaveStreamUrl(id));
  }

  return appendPublicGatewayUrls(id, urls);
}

/**
 * Resolve the best data URL for a tx id via curated path-style probes, then static gateways.
 */
export async function resolveWayfinderDataUrl(txId: string): Promise<string> {
  const urls = await resolveWayfinderDataUrls(txId);
  return urls[0] || preferredArweaveStreamUrl(txId);
}

/**
 * Ordered candidate URLs: fastest curated gateway first, then static public gateways.
 * Safe for `<img onError>` / audio error fallback chains. Concurrent calls share one probe per tx id.
 */
export async function resolveWayfinderDataUrls(txId: string): Promise<string[]> {
  const id = normalizeArweaveTxId(txId);
  if (!id) return [preferredArweaveStreamUrl(txId)];

  const cached = readCachedUrl(id);
  if (cached) {
    return appendPublicGatewayUrls(id, [cached]);
  }

  const inflight = resolveInflight.get(id);
  if (inflight) return inflight;

  const run = resolveWayfinderDataUrlsInternal(id).finally(() => {
    resolveInflight.delete(id);
  });
  resolveInflight.set(id, run);
  return run;
}

/** No-op — kept for call sites; path-style probes run on demand per tx id. */
export function warmWayfinderGateways(): void {}
