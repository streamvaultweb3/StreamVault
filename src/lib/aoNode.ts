/**
 * Portal-aligned AO HyperBEAM node config (permaweb/portal `AO_NODE`).
 * Single source of truth for mainnet spawn + read URLs.
 *
 * L1 data / GraphQL: use `arweave.net` (see arweaveDataGateway.ts).
 * AO process compute reads: Portal HB first, then Bazar HB (`app-1.forward.computer`). Not arweave.net — L1 gateway only.
 */
export const AO_NODE = {
  url: 'https://hb.portalinto.com',
  authority: 'a5ZMUKbGClAsKzB4SHDYrwkOZZHIIfpbaxrmKwUHCe8',
  scheduler: 'n_XZJhUnmldNFo4dhajoPZWhBXuJk-OcQr5JQ49c4Zo',
} as const;

/** Scheduler used by early StreamVault / permaweb profile spawns (not hosted on Portal HB). */
export const LEGACY_AO_SCHEDULER = '_GQ33BkPtZrqxA84vM8Zk-N2aO0toNNu_C-l-rawrBA';

export const HB_WRITE_FALLBACK_URL = 'https://app-1.forward.computer';

function cleanEnv(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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
  const explicitPrimary = cleanEnv(import.meta.env.VITE_AO_WRITE_URL as string | undefined);
  const explicitFallback = cleanEnv(import.meta.env.VITE_AO_WRITE_FALLBACK_URL as string | undefined);
  const ordered = [
    explicitPrimary,
    cleanEnv(import.meta.env.VITE_AO_URL as string | undefined),
    AO_NODE.url,
    explicitFallback,
    HB_WRITE_FALLBACK_URL,
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  return ordered
    .map((url) => url.replace(/\/+$/, ''))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

/** Bazar reads atomic asset + orderbook state from this HyperBEAM node. */
export const BAZAR_HB_NODE = 'https://app-1.forward.computer';

/** Ordered HyperBEAM nodes for process state reads (primary → fallback). */
export function resolveHbReadNodeUrls(): string[] {
  const primary =
    cleanEnv(import.meta.env.VITE_AO_READ_URL as string | undefined) ||
    cleanEnv(import.meta.env.VITE_AO_URL as string | undefined) ||
    AO_NODE.url;
  const explicitFallback = cleanEnv(import.meta.env.VITE_AO_READ_FALLBACK_URL as string | undefined);
  const ordered = [primary, explicitFallback, AO_NODE.url, BAZAR_HB_NODE].filter(Boolean) as string[];
  const seen = new Set<string>();
  return ordered
    .map((url) => url.replace(/\/+$/, ''))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
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
