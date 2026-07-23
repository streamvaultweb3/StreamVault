/**
 * Portal-aligned AO HyperBEAM node config (permaweb/portal `AO_NODE`).
 * Single source of truth for mainnet spawn + read URLs.
 *
 * L1 data / GraphQL: use `arweave.net` (see arweaveDataGateway.ts).
 * AO process compute reads: Bazar HB first by default, then Portal HB.
 * Optional operator node (`VITE_AO_OPERATOR_*`) is opt-in only — never default to arweave.nyc.
 */
export const AO_NODE = {
  url: 'https://hb.portalinto.com',
  authority: 'a5ZMUKbGClAsKzB4SHDYrwkOZZHIIfpbaxrmKwUHCe8',
  scheduler: 'n_XZJhUnmldNFo4dhajoPZWhBXuJk-OcQr5JQ49c4Zo',
} as const;

/** Scheduler used by early StreamVault / permaweb profile spawns (not hosted on Portal HB). */
export const LEGACY_AO_SCHEDULER = '_GQ33BkPtZrqxA84vM8Zk-N2aO0toNNu_C-l-rawrBA';

export const HB_WRITE_FALLBACK_URL = 'https://app-1.forward.computer';

/** Bazar reads atomic asset + orderbook state from this HyperBEAM node. */
export const BAZAR_HB_NODE = 'https://app-1.forward.computer';

export type AoNodeRole = 'write' | 'read' | 'both';

export type AoNodeId = 'portal' | 'bazar' | 'operator' | 'custom';

/** URL + scheduler + authority triple for one HyperBEAM node. */
export type AoNodeConfig = {
  id: AoNodeId;
  url: string;
  scheduler?: string;
  authority?: string;
  role: AoNodeRole;
};

function cleanEnv(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeHbUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function dedupeUrls(urls: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (!raw) continue;
    const url = normalizeHbUrl(raw);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function getAoMode(): 'mainnet' | 'legacy' {
  const raw = (import.meta.env.VITE_AO_MODE as string | undefined) || 'mainnet';
  return raw.toLowerCase() === 'legacy' ? 'legacy' : 'mainnet';
}

export function resolveAoNode() {
  return {
    url: cleanEnv(import.meta.env.VITE_AO_URL as string | undefined) || AO_NODE.url,
    authority:
      cleanEnv(import.meta.env.VITE_AO_AUTHORITY as string | undefined) || AO_NODE.authority,
    scheduler:
      cleanEnv(import.meta.env.VITE_AO_SCHEDULER as string | undefined) || AO_NODE.scheduler,
  };
}

/**
 * Optional operator HyperBEAM node (e.g. arweave.nyc).
 * Only present when `VITE_AO_OPERATOR_URL` is set — never injected into defaults otherwise.
 */
export function resolveOperatorAoNode(): AoNodeConfig | null {
  const url = cleanEnv(import.meta.env.VITE_AO_OPERATOR_URL as string | undefined);
  if (!url) return null;
  return {
    id: 'operator',
    url: normalizeHbUrl(url),
    scheduler: cleanEnv(import.meta.env.VITE_AO_OPERATOR_SCHEDULER as string | undefined) || undefined,
    authority: cleanEnv(import.meta.env.VITE_AO_OPERATOR_AUTHORITY as string | undefined) || undefined,
    role: 'both',
  };
}

/** Known Portal / Bazar / optional operator nodes with role + identity tags. */
export function resolveAoNodeRegistry(): AoNodeConfig[] {
  const portal = resolveAoNode();
  const operator = resolveOperatorAoNode();
  const nodes: AoNodeConfig[] = [
    {
      id: 'portal',
      url: normalizeHbUrl(portal.url),
      scheduler: portal.scheduler,
      authority: portal.authority,
      role: 'both',
    },
    {
      id: 'bazar',
      url: normalizeHbUrl(BAZAR_HB_NODE),
      // Bazar HB shares the Portal scheduler identity for many mainnet assets;
      // leave scheduler unset when unknown so matching only hits explicit triples.
      role: 'read',
    },
  ];
  if (operator) nodes.push(operator);
  return nodes;
}

/** Nodes whose configured scheduler matches a process spawn Scheduler tag. */
export function findRegistryNodesForScheduler(scheduler: string | null | undefined): AoNodeConfig[] {
  const target = String(scheduler || '').trim();
  if (!target) return [];
  return resolveAoNodeRegistry().filter((node) => node.scheduler && node.scheduler === target);
}

export function resolveLegacyAoEndpoints() {
  const node = resolveAoNode();
  return {
    muUrl: cleanEnv(import.meta.env.VITE_AO_MU_URL as string | undefined) || node.url,
    cuUrl: cleanEnv(import.meta.env.VITE_AO_CU_URL as string | undefined) || 'https://forward.computer',
    gatewayUrl:
      cleanEnv(import.meta.env.VITE_AO_GATEWAY_URL as string | undefined) || 'https://arweave.net',
    gqlUrl:
      cleanEnv(import.meta.env.VITE_AO_GQL_URL as string | undefined) ||
      'https://ao-search-gateway.goldsky.com/graphql',
  };
}

/** MU for legacy-scheduler zone writes (not Portal HB push). */
export function resolveLegacyProfileWriteMuUrl(): string {
  return (
    cleanEnv(import.meta.env.VITE_AO_LEGACY_MU_URL as string | undefined) ||
    'https://forward.computer'
  );
}

/** Ordered HyperBEAM nodes for profile zone writes (Portal scheduler → Portal HB first). */
export function resolveProfileZoneWriteNodeUrls(): string[] {
  return resolveHbWriteNodeUrls();
}

/** Ordered HyperBEAM nodes for pushing signed messages to a process schedule. */
export function resolveHbWriteNodeUrls(): string[] {
  const operator = resolveOperatorAoNode();
  const explicitPrimary = cleanEnv(import.meta.env.VITE_AO_WRITE_URL as string | undefined);
  const explicitFallback = cleanEnv(import.meta.env.VITE_AO_WRITE_FALLBACK_URL as string | undefined);
  // Portal (or explicit write URL) stays primary. Operator is an optional later hop when configured.
  return dedupeUrls([
    explicitPrimary,
    cleanEnv(import.meta.env.VITE_AO_URL as string | undefined),
    AO_NODE.url,
    explicitFallback,
    HB_WRITE_FALLBACK_URL,
    operator?.url,
  ]);
}

/**
 * Ordered HyperBEAM nodes for process state reads (primary → fallback).
 *
 * Prefer Bazar HB by default — Portal (`hb.portalinto.com`) often times out without a VPN
 * and under VPN can hang for ~8–30s. Slow Portal-first dryruns/reads stall UCM listing past
 * the browser user-gesture window so Wander never opens. Writes still use Portal via
 * `resolveHbWriteNodeUrls` + resilient push rewrite.
 *
 * Operator (`VITE_AO_OPERATOR_URL`) is intentionally omitted here — foreign schedules on
 * arweave.nyc often 500 (`case_clause`) and spam the console while burning latency.
 * Prefer operator only via `resolveHbReadNodeUrlsForScheduler` when spawn Scheduler matches.
 * Hydration may still push Portal schedules onto the operator (see hbHydration).
 *
 * Set `VITE_AO_READ_URL` to force a read primary (e.g. Portal when reachable).
 */
export function resolveHbReadNodeUrls(): string[] {
  const explicitRead = cleanEnv(import.meta.env.VITE_AO_READ_URL as string | undefined);
  const aoUrl = cleanEnv(import.meta.env.VITE_AO_URL as string | undefined) || AO_NODE.url;
  const explicitFallback =
    cleanEnv(import.meta.env.VITE_AO_READ_FALLBACK_URL as string | undefined) || BAZAR_HB_NODE;
  // Bazar first unless the operator explicitly pins reads to another node.
  const ordered = explicitRead
    ? [explicitRead, explicitFallback, BAZAR_HB_NODE, aoUrl, AO_NODE.url]
    : [explicitFallback, BAZAR_HB_NODE, aoUrl, AO_NODE.url];
  return dedupeUrls(ordered);
}

/**
 * Read URL order with scheduler-matching nodes first (operator / Portal when configs match).
 * Falls back to the default Bazar-first list when no scheduler match exists.
 * Operator URL appears only when its scheduler matches the process spawn tag.
 */
export function resolveHbReadNodeUrlsForScheduler(scheduler: string | null | undefined): string[] {
  const matching = findRegistryNodesForScheduler(scheduler).map((node) => node.url);
  return dedupeUrls([...matching, ...resolveHbReadNodeUrls()]);
}

/**
 * Nodes to warm after a write: scheduler match first, then Bazar + Portal, then optional
 * operator (spread Portal-owned state onto arweave.nyc when configured — hydrate only).
 */
export function resolveHbHydrateNodeUrls(preferredFirst: string[] = []): string[] {
  const operator = resolveOperatorAoNode();
  const portal = resolveAoNode().url || AO_NODE.url;
  return dedupeUrls([
    ...preferredFirst,
    BAZAR_HB_NODE,
    portal,
    AO_NODE.url,
    operator?.url,
  ]);
}

/** True when this URL is the configured operator node (e.g. arweave.nyc). */
export function isOperatorHbUrl(url: string | null | undefined): boolean {
  const operator = resolveOperatorAoNode();
  if (!operator || !url) return false;
  return normalizeHbUrl(url) === normalizeHbUrl(operator.url);
}

/** Build a HyperBEAM process read URL (default: asset state at `/compute/asset`). */
export function hyperbeamProcessUrl(
  processId: string,
  subpath: 'compute' | 'compute/asset' | 'now' = 'compute/asset',
  nodeBase?: string
): string {
  const base = (nodeBase || resolveHbReadNodeUrls()[0] || AO_NODE.url).replace(/\/+$/, '');
  const id = String(processId || '').trim();
  return `${base}/${id}~process@1.0/${subpath}`;
}

/** Portal HB asset state URL — use in UI for atomic assets spawned via StreamVault. */
export function portalHyperbeamAssetUrl(processId: string): string {
  return hyperbeamProcessUrl(processId, 'compute/asset', AO_NODE.url);
}
