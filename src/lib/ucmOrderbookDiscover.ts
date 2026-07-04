/**
 * Discover per-asset UCM micro orderbook + activity process ids from L1 spawn tags.
 * Metadata.OrderbookId and orderbook Info can lag on HyperBEAM after listing.
 */
import { fetchArweaveL1Graphql, normalizeArweaveTxId } from './arweaveDataGateway';
import { rememberAssetActivityId, rememberAssetOrderbookId } from './ucmOrderbookCache';

const DISCOVER_BY_ASSET_QUERY = `
  query StreamVaultUcmProcesses($tags: [TagFilter!]!, $first: Int!) {
    transactions(tags: $tags, first: $first, sort: HEIGHT_DESC) {
      edges {
        node {
          id
          block {
            height
            timestamp
          }
          tags {
            name
            value
          }
        }
      }
    }
  }
`;

const DISCOVER_BY_BLOCK_QUERY = `
  query StreamVaultUcmActivityInBlock($blockMin: Int!, $blockMax: Int!, $tags: [TagFilter!]!, $first: Int!) {
    transactions(block: { min: $blockMin, max: $blockMax }, tags: $tags, first: $first, sort: HEIGHT_DESC) {
      edges {
        node {
          id
          block {
            height
            timestamp
          }
          tags {
            name
            value
          }
        }
      }
    }
  }
`;

const DISCOVER_BY_ID_QUERY = `
  query StreamVaultUcmProcessById($ids: [ID!]!) {
    transactions(ids: $ids) {
      edges {
        node {
          id
          block {
            height
            timestamp
          }
          tags {
            name
            value
          }
        }
      }
    }
  }
`;

const ACTIVITY_PROCESS_TAG = { name: 'UCM-Process', values: ['Asset-Activity'] };
const ACTIVITY_TIMESTAMP_WINDOW_MS = 30_000;

export type DiscoveredUcmProcesses = {
  orderbookId: string | null;
  activityProcessId: string | null;
};

type SpawnNode = {
  id?: string;
  block?: { height?: number; timestamp?: number };
  tags?: { name: string; value: string }[];
};

type SpawnEdge = { node?: SpawnNode };


function tagValue(tags: { name: string; value: string }[] | undefined, name: string): string | null {
  if (!Array.isArray(tags)) return null;
  const hit = tags.find((t) => t.name === name);
  return hit?.value?.trim() || null;
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/_/g, '-');
}

function isOrderbookRole(role: string): boolean {
  const r = normalizeRole(role);
  return r === 'orderbook' || r === 'order-book';
}

function isActivityRole(role: string): boolean {
  const r = normalizeRole(role);
  return r === 'activity' || r === 'asset-activity';
}

function readUcmRole(tags: { name: string; value: string }[] | undefined): string {
  return tagValue(tags, 'UCM-Process') || tagValue(tags, 'UCM-Role') || '';
}

function readActivityFromOrderbookTags(tags: { name: string; value: string }[] | undefined): string | null {
  return (
    tagValue(tags, 'Activity-Process') ||
    tagValue(tags, 'Activity-Process-Id') ||
    tagValue(tags, 'ActivityProcess') ||
    null
  );
}

async function gqlQuery<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const json = await fetchArweaveL1Graphql({ query, variables });
    return (json?.data as T) || null;
  } catch {
    return null;
  }
}

function parseUcmProcessSpawns(
  edges: SpawnEdge[] | undefined,
  assetId: string
): DiscoveredUcmProcesses & { orderbookNode: SpawnNode | null } {
  let orderbookId: string | null = null;
  let activityProcessId: string | null = null;
  let orderbookNode: SpawnNode | null = null;

  for (const edge of edges || []) {
    const node = edge?.node;
    const processId = String(node?.id || '').trim();
    if (!processId) continue;
    const tags = node?.tags;
    const linkedAsset =
      tagValue(tags, 'Asset-ID') ||
      tagValue(tags, 'Asset-Id') ||
      tagValue(tags, 'Atomic-Asset') ||
      tagValue(tags, 'Base-Token');
    if (linkedAsset && linkedAsset !== assetId) continue;

    const role = readUcmRole(tags);
    if (isOrderbookRole(role)) {
      orderbookId = orderbookId || processId;
      orderbookNode = orderbookNode || node || null;
      continue;
    }
    if (isActivityRole(role)) {
      activityProcessId = activityProcessId || processId;
      continue;
    }
    if (!orderbookId && tags?.some((t) => t.name === 'UCM-Process' && t.value === 'Orderbook')) {
      orderbookId = processId;
      orderbookNode = orderbookNode || node || null;
    }
    if (!activityProcessId && tags?.some((t) => t.name === 'UCM-Process' && isActivityRole(t.value))) {
      activityProcessId = processId;
    }
  }

  return { orderbookId, activityProcessId, orderbookNode };
}

function pickBestActivityMatch(edges: SpawnEdge[] | undefined, orderbookTs: number): string | null {
  if (!orderbookTs) return null;
  let best: { id: string; delta: number } | null = null;
  for (const edge of edges || []) {
    const node = edge?.node;
    const id = String(node?.id || '').trim();
    if (!id) continue;
    const role = readUcmRole(node?.tags);
    if (role && !isActivityRole(role)) continue;
    const ts = Number(tagValue(node?.tags, 'Process-Timestamp') || 0);
    if (!ts) continue;
    const delta = Math.abs(ts - orderbookTs);
    if (delta <= ACTIVITY_TIMESTAMP_WINDOW_MS && (!best || delta < best.delta)) {
      best = { id, delta };
    }
  }
  return best?.id || null;
}

async function queryActivitySpawnsInBlock(blockHeight: number, first = 8): Promise<SpawnEdge[]> {
  const data = await gqlQuery<{ transactions?: { edges?: SpawnEdge[] } }>(DISCOVER_BY_BLOCK_QUERY, {
    blockMin: blockHeight,
    blockMax: blockHeight,
    first,
    tags: [ACTIVITY_PROCESS_TAG],
  });
  return data?.transactions?.edges || [];
}

async function queryRecentActivitySpawns(first = 24): Promise<SpawnEdge[]> {
  const data = await gqlQuery<{ transactions?: { edges?: SpawnEdge[] } }>(DISCOVER_BY_ASSET_QUERY, {
    first,
    tags: [ACTIVITY_PROCESS_TAG],
  });
  return data?.transactions?.edges || [];
}

async function querySpawnById(processId: string): Promise<SpawnNode | null> {
  const data = await gqlQuery<{ transactions?: { edges?: SpawnEdge[] } }>(DISCOVER_BY_ID_QUERY, {
    ids: [processId],
  });
  return data?.transactions?.edges?.[0]?.node || null;
}

/** Pair activity spawn to a known orderbook via L1 tags (Asset-Activity has no Asset-ID). */
export async function discoverActivityIdForOrderbook(orderbookId: string): Promise<string | null> {
  const id = String(orderbookId || '').trim();
  if (!id) return null;

  const orderbookNode = await querySpawnById(id);
  if (!orderbookNode) return null;

  const fromTags = readActivityFromOrderbookTags(orderbookNode.tags);
  if (fromTags) return fromTags;

  const orderbookTs = Number(tagValue(orderbookNode.tags, 'Process-Timestamp') || 0);
  const blockHeight = orderbookNode.block?.height;

  if (blockHeight) {
    const inBlock = await queryActivitySpawnsInBlock(blockHeight);
    const match = pickBestActivityMatch(inBlock, orderbookTs);
    if (match) return match;
    const sole = inBlock.find((edge) => isActivityRole(readUcmRole(edge?.node?.tags)));
    if (sole?.node?.id) return String(sole.node.id).trim();
  }

  if (orderbookTs) {
    const recent = await queryRecentActivitySpawns();
    const match = pickBestActivityMatch(recent, orderbookTs);
    if (match) return match;
  }

  return null;
}

async function discoverPairedActivity(orderbookNode: SpawnNode | null): Promise<string | null> {
  if (!orderbookNode) return null;

  const fromTags = readActivityFromOrderbookTags(orderbookNode.tags);
  if (fromTags) return fromTags;

  const orderbookTs = Number(tagValue(orderbookNode.tags, 'Process-Timestamp') || 0);
  const blockHeight = orderbookNode.block?.height;

  if (blockHeight) {
    const inBlock = await queryActivitySpawnsInBlock(blockHeight);
    const match = pickBestActivityMatch(inBlock, orderbookTs);
    if (match) return match;
    const sole = inBlock.find((edge) => isActivityRole(readUcmRole(edge?.node?.tags)));
    if (sole?.node?.id) return String(sole.node.id).trim();
  }

  if (orderbookTs) {
    const recent = await queryRecentActivitySpawns();
    return pickBestActivityMatch(recent, orderbookTs);
  }

  return null;
}

async function querySpawnsByAssetId(
  assetId: string,
  first = 12
): Promise<DiscoveredUcmProcesses & { orderbookNode: SpawnNode | null }> {
  const data = await gqlQuery<{ transactions?: { edges?: SpawnEdge[] } }>(DISCOVER_BY_ASSET_QUERY, {
    first,
    tags: [{ name: 'Asset-ID', values: [assetId] }],
  });
  return parseUcmProcessSpawns(data?.transactions?.edges, assetId);
}

/** Discover orderbook + activity AO process ids spawned for this atomic asset. */
export async function discoverUcmProcessesFromGraphql(assetId: string): Promise<DiscoveredUcmProcesses> {
  const id = normalizeArweaveTxId(assetId);
  if (!id) return { orderbookId: null, activityProcessId: null };

  try {
    const found = await querySpawnsByAssetId(id);
    let activityProcessId = found.activityProcessId;

    if (found.orderbookId && !activityProcessId) {
      activityProcessId = await discoverPairedActivity(found.orderbookNode);
    }

    if (found.orderbookId) rememberAssetOrderbookId(id, found.orderbookId);
    if (activityProcessId) rememberAssetActivityId(id, activityProcessId);

    return { orderbookId: found.orderbookId, activityProcessId };
  } catch {
    return { orderbookId: null, activityProcessId: null };
  }
}

export async function discoverDedicatedOrderbookIdFromGraphql(assetId: string): Promise<string | null> {
  const { orderbookId } = await discoverUcmProcessesFromGraphql(assetId);
  return orderbookId;
}

export async function discoverDedicatedActivityIdFromGraphql(assetId: string): Promise<string | null> {
  const { activityProcessId } = await discoverUcmProcessesFromGraphql(assetId);
  return activityProcessId;
}
