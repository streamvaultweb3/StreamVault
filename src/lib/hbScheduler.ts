/**
 * Resolve which HyperBEAM node should prefer-read a process based on spawn Scheduler tags.
 */
import { arweaveGraphqlEndpoint, fetchArweaveL1Graphql } from './arweaveDataGateway';
import {
  findRegistryNodesForScheduler,
  resolveHbReadNodeUrls,
  resolveHbReadNodeUrlsForScheduler,
  type AoNodeConfig,
} from './aoNode';

export type ProcessSpawnIdentity = {
  processId: string;
  scheduler: string | null;
  authority: string | null;
};

const spawnIdentityCache = new Map<string, ProcessSpawnIdentity>();

const SPAWN_TAGS_QUERY = `
  query StreamVaultProcessSpawn($ids: [ID!]!) {
    transactions(ids: $ids, first: 1) {
      edges {
        node {
          tags { name value }
        }
      }
    }
  }
`;

function getTagValue(tags: Array<{ name?: string; value?: string }>, names: string[]): string | null {
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const tag of tags) {
    const name = String(tag?.name || '').trim().toLowerCase();
    const value = String(tag?.value || '').trim();
    if (want.has(name) && value) return value;
  }
  return null;
}

function identityFromTags(
  processId: string,
  tags: Array<{ name?: string; value?: string }>
): ProcessSpawnIdentity {
  return {
    processId,
    scheduler: getTagValue(tags, ['Scheduler', 'Scheduler-Location', 'scheduler', 'scheduler-location']),
    authority: getTagValue(tags, ['Authority', 'authority']),
  };
}

/** AO Goldsky first (process spawns), then L1 GraphQL as a fallback. */
async function fetchSpawnTags(processId: string): Promise<Array<{ name?: string; value?: string }>> {
  const variables = { ids: [processId] };
  try {
    const res = await fetch(arweaveGraphqlEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: SPAWN_TAGS_QUERY, variables }),
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const json = await res.json();
      const tags = json?.data?.transactions?.edges?.[0]?.node?.tags;
      if (Array.isArray(tags) && tags.length > 0) return tags;
    }
  } catch {
    // fall through to L1
  }
  try {
    const json = await fetchArweaveL1Graphql({
      query: SPAWN_TAGS_QUERY,
      variables,
      timeoutMs: 4_000,
    });
    const tags = json?.data?.transactions?.edges?.[0]?.node?.tags;
    if (Array.isArray(tags)) return tags;
  } catch {
    // ignore
  }
  return [];
}

/** Load Scheduler / Authority from AO/L1 GraphQL spawn tags (cached). */
export async function fetchProcessSpawnIdentity(
  processId: string
): Promise<ProcessSpawnIdentity> {
  const id = String(processId || '').trim();
  if (!id) return { processId: '', scheduler: null, authority: null };
  const cached = spawnIdentityCache.get(id);
  if (cached) return cached;

  const tags = await fetchSpawnTags(id);
  const identity = identityFromTags(id, tags);
  spawnIdentityCache.set(id, identity);
  return identity;
}

/** Registry nodes that match this process's spawn Scheduler. */
export async function resolvePreferredNodesForProcess(
  processId: string
): Promise<AoNodeConfig[]> {
  const identity = await fetchProcessSpawnIdentity(processId);
  return findRegistryNodesForScheduler(identity.scheduler);
}

/**
 * Ordered HB read URLs for a process: scheduler-matching node(s) first, then default peers.
 * When operator env is unset / no match, this equals `resolveHbReadNodeUrls()` (Bazar-first).
 */
export async function resolveHbReadNodeUrlsForProcess(processId: string): Promise<string[]> {
  const identity = await fetchProcessSpawnIdentity(processId);
  if (!identity.scheduler) return resolveHbReadNodeUrls();
  return resolveHbReadNodeUrlsForScheduler(identity.scheduler);
}
