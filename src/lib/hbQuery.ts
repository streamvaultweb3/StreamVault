import { resolveAoNode } from './aoNode';

/**
 * HyperBEAM L1 mirror devices (not wired in StreamVault today):
 *
 * - `~copycat@1.0` — replicates arweave.net GraphQL / tx data into a node's cache
 * - `~query@1.0` — serves GraphQL against that cache (offline-first L1 discovery)
 * - `bundler@1.0` — ANS-104 bundling gateway; StreamVault uploads use Turbo instead
 *
 * Current stack: Turbo uploads, arweave.net GraphQL for L1 tags, Portal HB for AO process
 * state, Goldsky for AO process GraphQL. To migrate later, point `VITE_HB_QUERY_URL` at
 * `{portal}/~query@1.0/graphql` after copycat is configured on the HB node.
 */

/** Optional Portal HB query@1.0 GraphQL endpoint (future L1 mirror). */
export function hbQueryGraphqlEndpoint(): string | null {
  const explicit =
    typeof import.meta !== 'undefined'
      ? String(import.meta.env?.VITE_HB_QUERY_URL || '').trim()
      : '';
  if (explicit) return explicit.replace(/\/+$/, '');
  return null;
}

/** Base URL for a copycat@1.0 device on Portal HB (replication control, not used in browser). */
export function hbCopycatDeviceUrl(nodeBase?: string): string {
  const base = (nodeBase || resolveAoNode().url).replace(/\/+$/, '');
  return `${base}/~copycat@1.0`;
}

/** Whether StreamVault should prefer HB query over arweave.net for L1 GraphQL reads. */
export function preferHbQueryGraphql(): boolean {
  return Boolean(hbQueryGraphqlEndpoint());
}
