import { hbQueryGraphqlEndpoint } from './hbQuery';

/** Default Arweave HTTP gateway: GraphQL, `/{txId}`, `/tx/{txId}`, and `Arweave.init` API host. */
export const ARWEAVE_DATA_GATEWAY_BASE = 'https://arweave.net';
/**
 * Gateways used for availability probes (`Range` GET + `/tx/.../status`).
 * Stick to the canonical gateway only: turbo mirrors often 404 or redirect in ways that
 * confuse readiness checks and do not reflect whether `arweave.net/{id}` is live yet.
 */
export const ARWEAVE_FALLBACK_DATA_GATEWAY_BASES = ['https://arweave.net'] as const;

/**
 * Public data gateways for audio/artwork (path-style `/{txId}`).
 * Prefer arweave.net + Turbo — their sandbox redirects respond quickly.
 * permagate.io / ar-io.dev often 302 to sandbox hosts that hang without a VPN.
 */
export const ARWEAVE_PUBLIC_DATA_GATEWAY_BASES = [
  'https://arweave.net',
  'https://turbo-gateway.com',
  'https://permagate.io',
  'https://ar-io.dev',
] as const;

/** Gateways probed for fastest path-style resolution (excludes flaky redirect targets). */
export const ARWEAVE_RELIABLE_DATA_GATEWAY_BASES = [
  'https://arweave.net',
  'https://turbo-gateway.com',
] as const;

/** Public Turbo CDN base for optional secondary links (same id as `arweave.net/{id}` for bundled items). */
export const TURBO_PUBLIC_DATA_GATEWAY_BASE = 'https://turbo-gateway.com';

/**
 * L1 GraphQL endpoints that index ANS-110 `Type: music` / Turbo data-item tags.
 * Never include AO Goldsky (`ao-search-gateway.goldsky.com`) — it lacks those L1 tags.
 * Prefer goldsky search first when arweave.net is blocked (CORS/429) without a VPN.
 */
export const ARWEAVE_L1_GQL_FALLBACK_ENDPOINTS = [
  'https://arweave-search.goldsky.com/graphql',
  'https://arweave.net/graphql',
  'https://ar-io.dev/graphql',
] as const;

const L1_GQL_ATTEMPT_TIMEOUT_MS = 5_000;
const L1_GQL_COOLDOWN_MS = 2 * 60_000;

/** Last endpoint that returned a successful L1 GraphQL response. */
let preferredL1GraphqlEndpoint: string | null = null;
/** Endpoints that recently failed (CORS, timeout, 5xx) — skip until cooldown expires. */
const l1GraphqlCooldownUntil = new Map<string, number>();

const TX_ID_LIKE = /[a-zA-Z0-9_-]{43}/;

/** Extract a 43-char tx / data-item id if the caller passed a full URL or path. */
export function normalizeArweaveTxId(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (s.length === 43 && TX_ID_LIKE.test(s)) return s;
  const m = s.match(TX_ID_LIKE);
  return m ? m[0] : s;
}

export function arweaveDataGatewayHost(): {
  host: string;
  port: number;
  protocol: 'https';
} {
  return { host: 'arweave.net', port: 443, protocol: 'https' };
}

export function arweaveTxDataUrl(txId: string): string {
  const id = normalizeArweaveTxId(txId);
  return `${ARWEAVE_DATA_GATEWAY_BASE}/${id}`;
}

export function arweaveTxDataUrls(txId: string): string[] {
  const id = normalizeArweaveTxId(txId);
  return ARWEAVE_FALLBACK_DATA_GATEWAY_BASES.map((base) => `${base}/${id}`);
}

export function turboTxDataUrl(txId: string): string {
  const id = normalizeArweaveTxId(txId);
  return `${TURBO_PUBLIC_DATA_GATEWAY_BASE}/${id}`;
}

/** Ordered public data URLs for a tx (stream / artwork) — first is preferred. */
export function arweavePublicDataUrls(txId: string): string[] {
  const id = normalizeArweaveTxId(txId);
  return ARWEAVE_PUBLIC_DATA_GATEWAY_BASES.map((base) => `${base}/${id}`);
}

/** Preferred stream URL when `arweave.net` / Turbo may be blocked without a VPN. */
export function preferredArweaveStreamUrl(txId: string): string {
  return arweavePublicDataUrls(txId)[0] || turboTxDataUrl(txId);
}

export function arweaveTxMetaUrl(txId: string): string {
  const id = normalizeArweaveTxId(txId);
  return `${ARWEAVE_DATA_GATEWAY_BASE}/tx/${id}`;
}

export function arweaveTxStatusUrls(txId: string): string[] {
  const id = normalizeArweaveTxId(txId);
  return ARWEAVE_FALLBACK_DATA_GATEWAY_BASES.map((base) => `${base}/tx/${id}/status`);
}

/**
 * AO-oriented GraphQL (Goldsky): indexes AO process spawns well; L1 `Type: music` tags may be missing.
 * Use for AO registry / process discovery — not for StreamVault L1 audio upload discovery.
 */
export function arweaveGraphqlEndpoint(): string {
  const explicit =
    typeof import.meta !== 'undefined'
      ? String(import.meta.env?.VITE_AO_GQL_URL || import.meta.env?.VITE_ARWEAVE_GQL_URL || '').trim()
      : '';
  return explicit || 'https://ao-search-gateway.goldsky.com/graphql';
}

/**
 * L1 permaweb GraphQL for App-Name / Type:music / Content-Type audio discovery.
 * Defaults to arweave.net — AO Goldsky (`ao-search-gateway`) does not index ANS-110 `Type: music`.
 *
 * Future: set `VITE_HB_QUERY_URL` to Portal HB `~query@1.0` after copycat mirrors L1 — see hbQuery.ts.
 */
export function arweaveL1GraphqlEndpoint(): string {
  return arweaveL1GraphqlEndpoints()[0] || 'https://arweave.net/graphql';
}

/** Ordered L1 GraphQL endpoints (primary + geo/DNS fallbacks). */
export function arweaveL1GraphqlEndpoints(): string[] {
  const hbQuery = hbQueryGraphqlEndpoint();
  const explicit =
    typeof import.meta !== 'undefined'
      ? String(import.meta.env?.VITE_ARWEAVE_GQL_URL || '').trim()
      : '';
  const ordered: string[] = [];
  if (hbQuery) ordered.push(hbQuery.replace(/\/+$/, ''));
  // AO Goldsky lacks bundled L1 data-item tags — never use ao-search-gateway here.
  // arweave-search.goldsky.com is a different host and does index L1 Type:music.
  if (explicit && !/ao-search-gateway\.goldsky\.com/i.test(explicit)) {
    ordered.push(explicit.replace(/\/+$/, ''));
  }
  for (const url of ARWEAVE_L1_GQL_FALLBACK_ENDPOINTS) {
    if (!ordered.includes(url)) ordered.push(url);
  }
  return ordered;
}

function isRetryableL1GraphqlFailure(error: unknown, status?: number): boolean {
  if (status !== undefined && (status === 408 || status === 429 || status >= 500 || status === 0)) {
    return true;
  }
  const msg = String((error as { message?: string })?.message || error || '');
  // Blocked gateways often return HTML (Unexpected token '<') or fail CORS/preflight.
  return /failed to fetch|network|abort|timeout|ERR_|connection|Load failed|CORS|preflight|Unexpected token|is not valid JSON|JSON\.parse/i.test(
    msg
  );
}

function markL1GraphqlFailure(endpoint: string) {
  l1GraphqlCooldownUntil.set(endpoint, Date.now() + L1_GQL_COOLDOWN_MS);
  if (preferredL1GraphqlEndpoint === endpoint) preferredL1GraphqlEndpoint = null;
}

function markL1GraphqlSuccess(endpoint: string) {
  preferredL1GraphqlEndpoint = endpoint;
  l1GraphqlCooldownUntil.delete(endpoint);
}

function liveL1GraphqlEndpoints(): string[] {
  const now = Date.now();
  const all = arweaveL1GraphqlEndpoints();
  const live = all.filter((url) => (l1GraphqlCooldownUntil.get(url) || 0) <= now);
  if (preferredL1GraphqlEndpoint && live.includes(preferredL1GraphqlEndpoint)) {
    return [
      preferredL1GraphqlEndpoint,
      ...live.filter((url) => url !== preferredL1GraphqlEndpoint),
    ];
  }
  // If every endpoint is cooling down, try them all again.
  return live.length > 0 ? live : all;
}

async function postL1GraphqlEndpoint(
  endpoint: string,
  args: { query: string; variables?: Record<string, unknown> },
  timeoutMs: number
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: args.query, variables: args.variables }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const error = new Error(`GraphQL error: ${res.status} (${endpoint})`);
      (error as { status?: number }).status = res.status;
      throw error;
    }
    const json = await res.json();
    if (json.errors?.length) {
      // Schema/query errors are not gateway issues — do not cool down the host.
      throw new Error(json.errors.map((e: { message?: string }) => e.message).join('; '));
    }
    markL1GraphqlSuccess(endpoint);
    return json;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (isRetryableL1GraphqlFailure(error, status)) {
      markL1GraphqlFailure(endpoint);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST L1 GraphQL with sticky preferred host + parallel race across fallbacks.
 * Avoids waiting on blocked `arweave.net` (CORS/429) or hanging `ar-io.dev`.
 */
export async function fetchArweaveL1Graphql(args: {
  query: string;
  variables?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<any> {
  const timeoutMs = args.timeoutMs ?? L1_GQL_ATTEMPT_TIMEOUT_MS;
  const endpoints = liveL1GraphqlEndpoints();
  if (endpoints.length === 0) {
    throw new Error('Arweave L1 GraphQL unreachable on all gateways');
  }

  // Fast path: sticky host that worked recently.
  if (preferredL1GraphqlEndpoint && endpoints[0] === preferredL1GraphqlEndpoint) {
    try {
      return await postL1GraphqlEndpoint(preferredL1GraphqlEndpoint, args, timeoutMs);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (!isRetryableL1GraphqlFailure(error, status)) throw error;
    }
  }

  // Race remaining live endpoints; first success wins.
  const candidates =
    preferredL1GraphqlEndpoint && endpoints[0] === preferredL1GraphqlEndpoint
      ? endpoints.slice(1)
      : endpoints;
  if (candidates.length === 0) {
    throw new Error('Arweave L1 GraphQL unreachable on all gateways');
  }

  return await new Promise((resolve, reject) => {
    let pending = candidates.length;
    let settled = false;
    let lastError: unknown;

    for (const endpoint of candidates) {
      void postL1GraphqlEndpoint(endpoint, args, timeoutMs)
        .then((json) => {
          if (settled) return;
          settled = true;
          resolve(json);
        })
        .catch((error) => {
          lastError = error;
          pending -= 1;
          if (!settled && pending === 0) {
            reject(
              lastError instanceof Error
                ? lastError
                : new Error('Arweave L1 GraphQL unreachable on all gateways')
            );
          }
        });
    }
  });
}

/** Lunar explorer for AO process ids. */
export function lunarTxExplorerUrl(processId: string): string {
  const id = String(processId || '').trim();
  return `https://lunar.arweave.net/#/explorer/${encodeURIComponent(id)}`;
}
