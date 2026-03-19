/**
 * Arweave GraphQL-based discovery for StreamVault audio.
 * Queries by tags: App-Name: StreamVault, Content-Type: audio/*.
 */

import type { Track } from '../context/PlayerContext';
import type { RegisteredTrackRecord } from './aoMusicRegistry';
import { searchTracksOnAO } from './aoMusicRegistry';

const GATEWAY = 'https://arweave.net';

const GQL_URL = (import.meta as any).env?.VITE_ARWEAVE_GQL_URL || 'https://arweave.net/graphql';

export interface AudioTxNode {
  id: string;
  tags: { name: string; value: string }[];
  block?: { height: number; timestamp?: number };
  owner?: { address?: string };
}

export interface QueryAudioOptions {
  limit?: number;
  type?: 'audio-sample' | 'audio-full' | 'all';
  owner?: string;
  tagName?: string;
  tagValue?: string;
}

function getTag(node: AudioTxNode, name: string): string | undefined {
  const t = node.tags?.find((x) => x.name === name);
  return t?.value;
}

function nodeToTrack(node: AudioTxNode): Track {
  const title = getTag(node, 'Title') || 'Untitled';
  const artist = getTag(node, 'Artist') || getTag(node, 'Artist-Address') || 'Unknown';
  const txId = node.id;
  const streamUrl = `${GATEWAY}/${txId}`;
  const durationSec = getTag(node, 'Duration-Seconds');
  const duration = durationSec ? Math.round(Number(durationSec)) : undefined;
  const assetId = getTag(node, 'Track-Id');
  const creator = node.owner?.address || getTag(node, 'Artist-Address') || '';

  return {
    id: txId,
    title,
    artist,
    artistId: creator || txId,
    streamUrl,
    duration,
    isPermanent: true,
    permaTxId: txId,
    assetId: assetId || undefined,
  };
}

export async function queryAudioTransactions(
  options: QueryAudioOptions = {}
): Promise<Track[]> {
  const limit = Math.min(options.limit ?? 50, 100);
  const tags: { name: string; values: string[] }[] = [
    { name: 'App-Name', values: ['StreamVault'] },
    { name: 'Content-Type', values: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'] },
  ];
  if (options.type && options.type !== 'all') {
    tags.push({ name: 'Type', values: [options.type] });
  }
  if (options.tagName && options.tagValue) {
    tags.push({ name: options.tagName, values: [options.tagValue] });
  }

  const query = `
    query StreamVaultAudio($tags: [TagFilter!]!, $first: Int!) {
      transactions(tags: $tags, first: $first) {
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

  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL error: ${res.status}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e: any) => e.message).join('; '));
  }

  const edges = json?.data?.transactions?.edges ?? [];
  const nodes: AudioTxNode[] = edges.map((e: any) => e.node).filter(Boolean);
  let tracks = nodes.map(nodeToTrack);

  if (options.owner) {
    tracks = tracks.filter((t) => t.artistId?.toLowerCase() === options.owner?.toLowerCase());
  }
  return tracks;
}

export async function queryAudioByOwner(owner: string, limit = 50): Promise<Track[]> {
  const all = await queryAudioTransactions({ limit });
  return all.filter((t) => t.artistId?.toLowerCase() === owner.toLowerCase());
}

export async function queryAudioByTag(tagName: string, tagValue: string, limit = 50): Promise<Track[]> {
  return queryAudioTransactions({ limit, tagName, tagValue });
}

/** Convert AO registry records to Track[] (streamUrl = gateway/audioTxId). */
export function aoRecordsToTracks(records: RegisteredTrackRecord[]): Track[] {
  return records.map((r) => ({
    id: r.audioTxId,
    title: r.tags?.Title || 'Untitled',
    artist: r.tags?.Artist || r.creator?.slice(0, 8) + '…' || 'Unknown',
    artistId: r.creator,
    streamUrl: `${GATEWAY}/${r.audioTxId}`,
    duration: undefined,
    isPermanent: true,
    permaTxId: r.audioTxId,
    assetId: r.assetId,
  }));
}

/** Fetch trending: GraphQL + AO, merge by audioTxId, sort by time (newest first). */
export async function fetchTrendingTracks(limit = 24): Promise<Track[]> {
  const [gqlTracks, aoRecords] = await Promise.all([
    queryAudioTransactions({ limit, type: 'all' }),
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
  return merged.slice(0, limit);
}
