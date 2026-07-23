/**
 * Arweave GraphQL-based discovery for StreamVault L1 audio uploads.
 *
 * Primary index: App-Name + ANS-110 `Type: music` on data txs (not AO process spawns).
 * Fallback: Content-Type audio/* with `isStreamVaultAudioDataTx` filtering out `Data-Protocol=ao` + `Type=Process`.
 *
 * Endpoint: `fetchArweaveL1Graphql` (arweave.net → ar-io.dev → arweave-search.goldsky).
 * AO Goldsky (`ao-search-gateway`) lacks `Type: music` on L1 txs — never used here.
 *
 * AO HyperBEAM devices (future optional path — see hbQuery.ts):
 * - `~copycat@1.0` — replicate GraphQL/Arweave data into a node's cache
 * - `~query@1.0` — search replicated cache locally (set VITE_HB_QUERY_URL to enable)
 * - bundler@1.0 — gateway ANS-104 bundling; StreamVault uploads use Turbo today
 *
 * @see https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-110.md
 */

import type { Track } from '../context/PlayerContext';
import type { RegisteredTrackRecord } from './aoMusicRegistry';
import { searchTracksOnAO } from './aoMusicRegistry';
import {
  fetchArweaveL1Graphql,
  preferredArweaveStreamUrl,
} from './arweaveDataGateway';
import { fetchHyperbeamAssetState } from './hbNode';
import { findUploadLedgerByTxId } from './uploadLedger';
import { resolveProfileMediaUrl } from './permaProfile';
import type { UploadedTrackRecord } from './uploadedTracks';
const ASSET_BY_AUDIO_QUERY = `
  query StreamVaultAssetByAudio($tags: [TagFilter!]!, $first: Int!) {
    transactions(tags: $tags, first: $first, sort: HEIGHT_DESC) {
      edges {
        node {
          id
          tags { name value }
        }
      }
    }
  }
`;

const ATOMIC_ASSETS_QUERY = `
  query StreamVaultAtomicAssets($tags: [TagFilter!]!, $first: Int!, $owners: [String!]) {
    transactions(tags: $tags, first: $first, owners: $owners, sort: HEIGHT_DESC) {
      edges {
        node {
          id
          tags { name value }
          block { height timestamp }
          owner { address }
        }
      }
    }
  }
`;

export interface AudioTxNode {
  id: string;
  tags: { name: string; value: string }[];
  block?: { height: number; timestamp?: number };
  owner?: { address?: string };
}

export interface QueryAudioOptions {
  limit?: number;
  owner?: string;
  tagName?: string;
  tagValue?: string;
}

function getTag(node: AudioTxNode, name: string): string | undefined {
  const t = node.tags?.find((x) => x.name === name);
  return t?.value;
}

function nodeToUploadedTrack(node: AudioTxNode): UploadedTrackRecord {
  const txId = node.id;
  const title = getTag(node, 'Title') || 'Untitled';
  const artist = getTag(node, 'Artist') || getTag(node, 'Artist-Address') || 'Unknown';
  return {
    txId,
    title,
    artist,
    permawebUrl: preferredArweaveStreamUrl(txId),
    arioUrl: preferredArweaveStreamUrl(txId),
    createdAt: node.block?.timestamp
      ? new Date(node.block.timestamp * 1000).toISOString()
      : new Date(0).toISOString(),
    walletAddress: node.owner?.address,
    assetId: getTag(node, 'Track-Id') || undefined,
    audiusTrackId: getTag(node, 'Audius-Track-Id'),
    artworkTxId:
      getTag(node, 'Artwork-Tx-Id') ||
      getTag(node, 'Cover-Art-Tx-Id') ||
      getTag(node, 'Thumbnail-Tx-Id'),
    contentType: getTag(node, 'Content-Type'),
    description: getTag(node, 'Description'),
    udl:
      getTag(node, 'License') || getTag(node, 'License-Use') || getTag(node, 'License-AI-Use')
        ? {
            licenseId: getTag(node, 'License') || 'udl://music/1.0',
            usage: (getTag(node, 'License-Use') || '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            aiUse: (getTag(node, 'License-AI-Use') || 'deny') as any,
            fee: getTag(node, 'License-Fee') || '0',
            currency: getTag(node, 'License-Currency') || 'MATIC',
            interval: (getTag(node, 'License-Fee-Unit') || 'per-stream') as any,
            attribution: getTag(node, 'License-Attribution') as any,
            uri: getTag(node, 'License-URI'),
          }
        : undefined,
  };
}

function nodeToTrack(node: AudioTxNode): Track {
  const uploaded = nodeToUploadedTrack(node);
  const durationSec = getTag(node, 'Duration-Seconds');
  const duration = durationSec ? Math.round(Number(durationSec)) : undefined;
  const assetId = getTag(node, 'Track-Id');
  const creator = node.owner?.address || getTag(node, 'Artist-Address') || '';

  return {
    id: uploaded.txId,
    title: uploaded.title,
    artist: uploaded.artist,
    artistId: creator || uploaded.txId,
    artwork: uploaded.artworkTxId ? resolveProfileMediaUrl(uploaded.artworkTxId) || undefined : undefined,
    streamUrl: preferredArweaveStreamUrl(uploaded.txId),
    duration,
    isPermanent: true,
    permaTxId: uploaded.txId,
    assetId: assetId || undefined,
  };
}

export async function queryAudioTransactions(
  options: QueryAudioOptions = {}
): Promise<Track[]> {
  const nodes = await queryAudioTransactionsRaw(options);
  let tracks = nodes.map(nodeToTrack);

  if (options.owner) {
    tracks = tracks.filter((t) => t.artistId?.toLowerCase() === options.owner?.toLowerCase());
  }
  return tracks;
}

export async function queryPermanentUploads(options: QueryAudioOptions = {}): Promise<UploadedTrackRecord[]> {
  const limit = Math.min(options.limit ?? 24, 100);
  const tracks = await enrichTracksWithAtomicAssetIds(
    await queryAudioTransactions({ ...options, limit })
  );
  return tracks.map(trackToUploadRecord);
}

function isAtomicAssetProcessNode(node: AudioTxNode): boolean {
  return getTag(node, 'Data-Protocol') === 'ao' && getTag(node, 'Type') === 'Process';
}

/** L1 audio data txs only — excludes AO atomic-asset process spawns (also tagged audio/mpeg). */
function isStreamVaultAudioDataTx(node: AudioTxNode): boolean {
  if (isAtomicAssetProcessNode(node)) return false;
  if (getTag(node, 'Type') === 'music') return true;
  const ct = getTag(node, 'Content-Type') || '';
  return /^audio\//i.test(ct);
}

const AUDIO_CONTENT_TYPE_FALLBACKS = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/flac',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
] as const;

function dedupeAudioNodes(nodes: AudioTxNode[]): AudioTxNode[] {
  const seen = new Set<string>();
  const out: AudioTxNode[] = [];
  for (const node of nodes) {
    const id = String(node?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(node);
  }
  return out;
}

async function fetchAudioTransactionsByTags(
  options: QueryAudioOptions,
  tagFilters: { name: string; values: string[] }[]
): Promise<AudioTxNode[]> {
  const limit = Math.min(options.limit ?? 50, 100);
  const owner = String(options.owner || '').trim();
  const tags: { name: string; values: string[] }[] = [
    { name: 'App-Name', values: ['StreamVault'] },
    ...tagFilters,
  ];
  if (options.tagName && options.tagValue) {
    tags.push({ name: options.tagName, values: [options.tagValue] });
  }

  const query = owner
    ? `
    query StreamVaultAudioByOwner($tags: [TagFilter!]!, $first: Int!, $owners: [String!]) {
      transactions(tags: $tags, first: $first, owners: $owners, sort: HEIGHT_DESC) {
        edges {
          node {
            id
            tags { name value }
            block { height timestamp }
            owner { address }
          }
        }
      }
    }
  `
    : `
    query StreamVaultAudio($tags: [TagFilter!]!, $first: Int!) {
      transactions(tags: $tags, first: $first, sort: HEIGHT_DESC) {
        edges {
          node {
            id
            tags { name value }
            block { height timestamp }
            owner { address }
          }
        }
      }
    }
  `;

  const variables: Record<string, unknown> = {
    tags: tags.map((t) => ({ name: t.name, values: t.values })),
    first: limit,
  };
  if (owner) variables.owners = [owner];

  const json = await fetchArweaveL1Graphql({ query, variables });
  const edges = json?.data?.transactions?.edges ?? [];
  return edges.map((e: any) => e.node).filter(Boolean) as AudioTxNode[];
}

async function queryAudioTransactionsRaw(options: QueryAudioOptions = {}): Promise<AudioTxNode[]> {
  let nodes = dedupeAudioNodes(
    (await fetchAudioTransactionsByTags(options, [{ name: 'Type', values: ['music'] }])).filter(
      isStreamVaultAudioDataTx
    )
  );

  if (nodes.length === 0) {
    for (const contentType of AUDIO_CONTENT_TYPE_FALLBACKS) {
      const fallback = (
        await fetchAudioTransactionsByTags(options, [{ name: 'Content-Type', values: [contentType] }])
      ).filter(isStreamVaultAudioDataTx);
      if (fallback.length > 0) {
        nodes = dedupeAudioNodes(fallback);
        break;
      }
    }
  }

  return nodes;
}

/** Resolve L1 audio data tx from an atomic asset AO process id (spawn tags or map reverse lookup). */
export async function findAudioTxIdForAtomicAsset(assetId: string): Promise<string | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;

  try {
    const json = await fetchArweaveL1Graphql({
      query: `
          query StreamVaultAudioForAsset($id: ID!) {
            transaction(id: $id) {
              id
              tags { name value }
            }
          }
        `,
      variables: { id },
    });
    const tags = json?.data?.transaction?.tags ?? [];
    const audioTx =
      getTag({ id, tags }, 'Track-AudioTx') ||
      getTag({ id, tags }, 'Bootloader-AudioTxId') ||
      getTag({ id, tags }, 'Data-Source');
    const linked = String(audioTx || '').trim();
    if (linked && linked !== id) return linked;
  } catch {
    // ignore
  }

  try {
    const map = await fetchAtomicAssetMap({ limit: 100 });
    for (const [audioTx, processId] of map.entries()) {
      if (processId === id) return audioTx;
    }
  } catch {
    // ignore
  }

  return null;
}

export async function findAtomicAssetIdForAudioTx(audioTxId: string): Promise<string | null> {
  const txId = String(audioTxId || '').trim();
  if (!txId) return null;

  const tagSets: Array<Array<{ name: string; values: string[] }>> = [
    [
      { name: 'Track-AudioTx', values: [txId] },
      { name: 'App-Name', values: ['StreamVault'] },
    ],
    [
      { name: 'Track-AudioTx', values: [txId] },
      { name: 'Data-Protocol', values: ['ao'] },
      { name: 'Type', values: ['Process'] },
    ],
    [{ name: 'Bootloader-AudioTxId', values: [txId] }],
  ];

  for (const tags of tagSets) {
    try {
      const json = await fetchArweaveL1Graphql({
        query: ASSET_BY_AUDIO_QUERY,
        variables: { first: 10, tags },
      });
      const edges = json?.data?.transactions?.edges ?? [];
      for (const edge of edges) {
        const node = edge?.node;
        const id = String(node?.id || '').trim();
        if (!id || id === txId) continue;
        return id;
      }
    } catch {
      // try next tag set
    }
  }
  return null;
}

function parseAtomicAssetMapFromNodes(nodes: AudioTxNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    const assetId = String(node.id || '').trim();
    if (!assetId) continue;
    const audioTx =
      getTag(node, 'Track-AudioTx') ||
      getTag(node, 'Bootloader-AudioTxId') ||
      getTag(node, 'Data-Source');
    const linked = String(audioTx || '').trim();
    if (linked && linked !== assetId) map.set(linked, assetId);
  }
  return map;
}

/** Batch map audio data tx id → atomic asset process id (AO Process spawns). */
export async function fetchAtomicAssetMap(options?: {
  creator?: string | null;
  limit?: number;
}): Promise<Map<string, string>> {
  const creator = String(options?.creator || '').trim();
  const tags = [
    { name: 'App-Name', values: ['StreamVault'] },
    { name: 'Data-Protocol', values: ['ao'] },
    { name: 'Type', values: ['Process'] },
  ];
  try {
    const json = await fetchArweaveL1Graphql({
      query: ATOMIC_ASSETS_QUERY,
      variables: {
        tags,
        first: Math.min(options?.limit ?? 100, 100),
        owners: creator ? [creator] : null,
      },
    });
    const edges = json?.data?.transactions?.edges ?? [];
    const nodes = edges.map((e: any) => e.node).filter(Boolean) as AudioTxNode[];
    return parseAtomicAssetMapFromNodes(nodes);
  } catch {
    return new Map();
  }
}

export type AtomicAssetSummary = {
  assetId: string;
  audioTxId: string | null;
  title: string;
  artist: string;
  artworkTxId?: string;
  walletAddress?: string;
  createdAt?: string;
};

/** Atomic asset AO processes for a creator wallet (for profile / badges). */
export async function queryAtomicAssetsByCreator(
  creator: string,
  limit = 50
): Promise<AtomicAssetSummary[]> {
  const owner = String(creator || '').trim();
  if (!owner) return [];
  const tags = [
    { name: 'App-Name', values: ['StreamVault'] },
    { name: 'Data-Protocol', values: ['ao'] },
    { name: 'Type', values: ['Process'] },
  ];
  try {
    const json = await fetchArweaveL1Graphql({
      query: ATOMIC_ASSETS_QUERY,
      variables: { tags, first: Math.min(limit, 100), owners: [owner] },
    });
    const edges = json?.data?.transactions?.edges ?? [];
    return edges
      .map((e: any) => e.node as AudioTxNode)
      .filter(Boolean)
      .map((node: AudioTxNode) => {
        const assetId = node.id;
        const audioTxId =
          getTag(node, 'Track-AudioTx') ||
          getTag(node, 'Bootloader-AudioTxId') ||
          getTag(node, 'Data-Source') ||
          null;
        return {
          assetId,
          audioTxId,
          title: getTag(node, 'Title') || getTag(node, 'Bootloader-Name') || 'Untitled',
          artist: getTag(node, 'Artist') || getTag(node, 'Bootloader-Artist') || 'Unknown',
          artworkTxId:
            getTag(node, 'Artwork-Tx-Id') ||
            getTag(node, 'Bootloader-ArtworkTxId') ||
            getTag(node, 'Bootloader-CoverArt') ||
            undefined,
          walletAddress: node.owner?.address || getTag(node, 'Creator') || owner,
          createdAt: node.block?.timestamp
            ? new Date(node.block.timestamp * 1000).toISOString()
            : undefined,
        } satisfies AtomicAssetSummary;
      });
  } catch {
    return [];
  }
}

/** Resolve atomic asset process id for audio txs (Track-AudioTx reverse lookup + local ledger). */
export async function enrichTracksWithAtomicAssetIds(
  tracks: Track[],
  hintMap?: Map<string, string>
): Promise<Track[]> {
  const missing = tracks.filter((t) => !String(t.assetId || '').trim());
  if (missing.length === 0) return tracks;

  const assetIdByAudioTx = new Map<string, string>(hintMap || []);

  const stillNeedLookup = missing.filter((track) => {
    const txId = String(track.permaTxId || track.id || '').trim();
    return txId && !assetIdByAudioTx.has(txId);
  });

  if (stillNeedLookup.length > 0) {
    const creators = new Set(
      stillNeedLookup.map((t) => String(t.artistId || '').trim()).filter((id) => id.length >= 40)
    );
    const batch =
      creators.size === 1
        ? await fetchAtomicAssetMap({ creator: [...creators][0], limit: 100 })
        : await fetchAtomicAssetMap({ limit: 100 });
    batch.forEach((assetId, audioTx) => assetIdByAudioTx.set(audioTx, assetId));
  }

  await Promise.all(
    stillNeedLookup.map(async (track) => {
      const txId = String(track.permaTxId || track.id || '').trim();
      if (!txId || assetIdByAudioTx.has(txId)) return;
      const fromLedger = findUploadLedgerByTxId(txId)?.assetId;
      if (fromLedger) {
        assetIdByAudioTx.set(txId, fromLedger);
        return;
      }
      const fromGraphql = await findAtomicAssetIdForAudioTx(txId);
      if (fromGraphql) assetIdByAudioTx.set(txId, fromGraphql);
    })
  );

  if (assetIdByAudioTx.size === 0) return tracks;
  return tracks.map((track) => {
    const txId = String(track.permaTxId || track.id || '').trim();
    const assetId = track.assetId || assetIdByAudioTx.get(txId);
    return assetId ? { ...track, assetId } : track;
  });
}

function trackToUploadRecord(track: Track): UploadedTrackRecord {
  const txId = track.permaTxId || track.id;
  let artworkTxId: string | undefined;
  if (track.artwork) {
    const match = track.artwork.match(/[A-Za-z0-9_-]{43}/);
    if (match) artworkTxId = match[0];
  }
  return {
    txId,
    title: track.title,
    artist: track.artist,
    permawebUrl: preferredArweaveStreamUrl(txId),
    arioUrl: preferredArweaveStreamUrl(txId),
    createdAt: new Date(0).toISOString(),
    walletAddress: track.artistId,
    assetId: track.assetId,
    artworkTxId,
    artworkUrl: track.artwork,
  };
}

export async function queryAudioByOwner(owner: string, limit = 50): Promise<Track[]> {
  const tracks = await queryAudioTransactions({ owner, limit });
  return enrichTracksWithAtomicAssetIds(tracks);
}

/** Permaweb uploads for a wallet owner (GraphQL + atomic asset id enrichment). */
export async function queryPermanentUploadsByOwner(
  owner: string,
  limit = 50
): Promise<UploadedTrackRecord[]> {
  const assetMap = await fetchAtomicAssetMap({ creator: owner, limit: 100 });
  const tracks = await enrichTracksWithAtomicAssetIds(
    await queryAudioTransactions({ owner, limit }),
    assetMap
  );
  return tracks.map(trackToUploadRecord);
}

export async function queryAudioByTag(tagName: string, tagValue: string, limit = 50): Promise<Track[]> {
  return queryAudioTransactions({ limit, tagName, tagValue });
}

/** Convert AO registry records to Track[] (streamUrl = gateway/audioTxId). */
export function aoRecordsToTracks(records: RegisteredTrackRecord[]): Track[] {
  return records.map((r) => {
    const artworkTxId =
      r.tags?.['Artwork-Tx-Id'] ||
      r.tags?.['Cover-Art-Tx-Id'] ||
      r.tags?.['Thumbnail-Tx-Id'];
    return {
      id: r.audioTxId,
      title: r.tags?.Title || 'Untitled',
      artist: r.tags?.Artist || r.creator?.slice(0, 8) + '…' || 'Unknown',
      artistId: r.creator,
      artwork: artworkTxId ? resolveProfileMediaUrl(artworkTxId) || undefined : undefined,
      streamUrl: preferredArweaveStreamUrl(r.audioTxId),
      duration: undefined,
      isPermanent: true,
      permaTxId: r.audioTxId,
      assetId: r.assetId,
    };
  });
}

export type AtomicAssetDisplayMetadata = {
  title?: string;
  artist?: string;
  creator?: string;
  artworkUrl?: string;
};

/** Title / artist / artwork from atomic asset HyperBEAM state when L1 tx tags are missing. */
export async function fetchAtomicAssetDisplayMetadata(
  assetId: string
): Promise<AtomicAssetDisplayMetadata | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;
  try {
    const hb = await fetchHyperbeamAssetState(id);
    if (!hb?.json) return null;
    const json = hb.json as Record<string, unknown>;
    const metadata = (json.Metadata || json.metadata) as Record<string, unknown> | undefined;
    const title =
      (typeof metadata?.title === 'string' && metadata.title) ||
      (typeof metadata?.Title === 'string' && metadata.Title) ||
      (typeof json.Name === 'string' && json.Name) ||
      (typeof json['Bootloader-Name'] === 'string' && json['Bootloader-Name']) ||
      undefined;
    const artist =
      (typeof metadata?.artist === 'string' && metadata.artist) ||
      (typeof metadata?.Artist === 'string' && metadata.Artist) ||
      (typeof json['Bootloader-Artist'] === 'string' && json['Bootloader-Artist']) ||
      undefined;
    const creator =
      (typeof json.Creator === 'string' && json.Creator) ||
      (typeof metadata?.creator === 'string' && metadata.creator) ||
      undefined;
    const artworkUrl = pickAtomicArtwork(json);
    if (!title && !artist && !artworkUrl) return null;
    return { title, artist, creator, artworkUrl };
  } catch {
    return null;
  }
}

function pickAtomicArtwork(info: Record<string, unknown>): string | undefined {
  const metadata = (info.Metadata || info.metadata) as Record<string, unknown> | undefined;
  const artworkTxId =
    (metadata?.artworkTxId as string | undefined) ||
    (metadata?.ArtworkTxId as string | undefined) ||
    (info['Artwork-Tx-Id'] as string | undefined);
  if (artworkTxId) return resolveProfileMediaUrl(artworkTxId) || undefined;
  const artworkRaw =
    metadata?.artwork ||
    metadata?.Artwork ||
    metadata?.image ||
    metadata?.Image ||
    metadata?.thumbnail ||
    metadata?.Thumbnail;
  const resolved = resolveProfileMediaUrl(artworkRaw);
  return resolved || undefined;
}

async function enrichTrackArtworkFromAtomicAssets(tracks: Track[]): Promise<Track[]> {
  const needsArtwork = tracks.filter((track) => !track.artwork && track.assetId);
  if (needsArtwork.length === 0) return tracks;

  const artworkByAssetId = new Map<string, string>();
  await Promise.all(
    needsArtwork.map(async (track) => {
      const assetId = String(track.assetId || '').trim();
      if (!assetId || artworkByAssetId.has(assetId)) return;
      try {
        const hb = await fetchHyperbeamAssetState(assetId);
        const artwork = hb?.json ? pickAtomicArtwork(hb.json) : undefined;
        if (artwork) artworkByAssetId.set(assetId, artwork);
      } catch {
        // ignore per-asset failures
      }
    })
  );

  if (artworkByAssetId.size === 0) return tracks;
  return tracks.map((track) => {
    if (track.artwork || !track.assetId) return track;
    const artwork = artworkByAssetId.get(track.assetId);
    return artwork ? { ...track, artwork } : track;
  });
}

/** Fetch trending: GraphQL + AO, merge by audioTxId, sort by time (newest first). */
export async function fetchTrendingTracks(limit = 24): Promise<Track[]> {
  const [gqlTracks, aoRecords] = await Promise.all([
    queryAudioTransactions({ limit }),
    searchTracksOnAO({}).catch(() => []),
  ]);
  const aoTracks = aoRecordsToTracks(aoRecords);
  const byTxId = new Map<string, Track>();
  gqlTracks.forEach((t) => byTxId.set(t.id, t));
  aoTracks.forEach((t) => {
    if (!byTxId.has(t.id)) byTxId.set(t.id, t);
    else {
      const existing = byTxId.get(t.id)!;
      if (t.assetId) existing.assetId = t.assetId;
      if (t.artistId && t.artistId.length > 10) existing.artistId = t.artistId;
    }
  });
  const merged = Array.from(byTxId.values());
  merged.sort((a, b) => {
    const aRec = aoRecords.find((r) => r.audioTxId === a.id);
    const bRec = aoRecords.find((r) => r.audioTxId === b.id);
    const aTime = aRec?.createdAt ?? 0;
    const bTime = bRec?.createdAt ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return 0;
  });
  const withAssetIds = await enrichTracksWithAtomicAssetIds(
    merged.slice(0, limit),
    await fetchAtomicAssetMap({ limit: 100 })
  );
  const enriched = await enrichTrackArtworkFromAtomicAssets(withAssetIds);
  return enriched;
}
