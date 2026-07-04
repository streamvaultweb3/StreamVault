import type { Track } from '../context/PlayerContext';
import { preferredArweaveStreamUrl, arweaveTxDataUrl } from './arweaveDataGateway';
import { trackSourceBadges } from './trackBadges';
import type { RoyaltySplit, UdlConfig } from './udl';

export type UploadedTrackUdlSummary = Pick<
  UdlConfig,
  'licenseId' | 'usage' | 'aiUse' | 'fee' | 'currency' | 'interval' | 'attribution' | 'uri'
>;

export type UploadedTrackRecord = {
  txId: string;
  title: string;
  artist: string;
  permawebUrl?: string;
  arioUrl?: string;
  confirmed?: boolean;
  gatewayReady?: boolean;
  assetId?: string;
  createdAt: string;
  walletAddress?: string;
  tier?: 'sample' | 'full';
  dataTxOnly?: boolean;
  audiusTrackId?: string;
  description?: string;
  /** Optional Arweave tx id for separately uploaded artwork (cover/thumbnail). */
  artworkTxId?: string;
  artworkUrl?: string;
  contentType?: string;
  udl?: UploadedTrackUdlSummary;
  splits?: RoyaltySplit[];
};

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseUsage(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  return undefined;
}

function parseSplits(value: unknown): RoyaltySplit[] | undefined {
  if (Array.isArray(value)) return value as RoyaltySplit[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as RoyaltySplit[]) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function udlToSummary(udl?: UdlConfig | null): UploadedTrackUdlSummary | undefined {
  if (!udl) return undefined;
  return {
    licenseId: udl.licenseId,
    usage: Array.isArray(udl.usage) ? udl.usage : [],
    aiUse: udl.aiUse,
    fee: udl.fee,
    currency: udl.currency,
    interval: udl.interval,
    attribution: udl.attribution,
    uri: udl.uri,
  };
}

export function normalizeUploadedTrackRecord(raw: unknown): UploadedTrackRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const txId = pickString(row.txId) || pickString(row.TxId) || pickString(row.audioTxId) || pickString(row.AudioTxId);
  if (!txId) return null;
  const title = pickString(row.title) || pickString(row.Title) || 'Untitled';
  const artist = pickString(row.artist) || pickString(row.Artist) || '';
  const permawebUrl = pickString(row.permawebUrl) || pickString(row.PermawebUrl);
  const arioUrl = pickString(row.arioUrl) || pickString(row.ArioUrl);
  const createdAt =
    pickString(row.createdAt) ||
    pickString(row.CreatedAt) ||
    new Date(0).toISOString();
  const udlSource = (row.udl || row.UDL) as UdlConfig | UploadedTrackUdlSummary | undefined;
  const usage = parseUsage((udlSource as any)?.usage ?? row['License-Use'] ?? row.licenseUse);
  const normalizedUdl =
    udlSource && typeof udlSource === 'object'
      ? {
          licenseId:
            pickString((udlSource as any).licenseId) ||
            pickString((udlSource as any).License) ||
            pickString(row.License) ||
            'udl://music/1.0',
          usage: usage || [],
          aiUse:
            (pickString((udlSource as any).aiUse) ||
              pickString(row['License-AI-Use']) ||
              'deny') as UploadedTrackUdlSummary['aiUse'],
          fee:
            pickString((udlSource as any).fee) ||
            pickString(row['License-Fee']) ||
            '0',
          currency:
            pickString((udlSource as any).currency) ||
            pickString(row['License-Currency']) ||
            'MATIC',
          interval:
            (pickString((udlSource as any).interval) ||
              pickString(row['License-Fee-Unit']) ||
              'per-stream') as UploadedTrackUdlSummary['interval'],
          attribution:
            (pickString((udlSource as any).attribution) ||
              pickString(row['License-Attribution'])) as UploadedTrackUdlSummary['attribution'],
          uri:
            pickString((udlSource as any).uri) ||
            pickString(row['License-URI']),
        }
      : pickString(row.License) || pickString(row['License-Use']) || pickString(row['License-AI-Use'])
        ? {
            licenseId: pickString(row.License) || 'udl://music/1.0',
            usage: usage || [],
            aiUse: (pickString(row['License-AI-Use']) || 'deny') as UploadedTrackUdlSummary['aiUse'],
            fee: pickString(row['License-Fee']) || '0',
            currency: pickString(row['License-Currency']) || 'MATIC',
            interval: (pickString(row['License-Fee-Unit']) || 'per-stream') as UploadedTrackUdlSummary['interval'],
            attribution: pickString(row['License-Attribution']) as UploadedTrackUdlSummary['attribution'],
            uri: pickString(row['License-URI']),
          }
        : undefined;

  return {
    txId,
    title,
    artist,
    permawebUrl,
    arioUrl,
    confirmed: typeof row.confirmed === 'boolean' ? row.confirmed : undefined,
    gatewayReady: typeof row.gatewayReady === 'boolean' ? row.gatewayReady : undefined,
    assetId: pickString(row.assetId) || pickString(row.AssetId),
    createdAt,
    walletAddress: pickString(row.walletAddress) || pickString(row.WalletAddress),
    tier: row.tier === 'sample' || row.tier === 'full' ? row.tier : undefined,
    dataTxOnly: typeof row.dataTxOnly === 'boolean' ? row.dataTxOnly : undefined,
    audiusTrackId: pickString(row.audiusTrackId) || pickString(row['Audius-Track-Id']),
    description: pickString(row.description) || pickString(row.Description),
    artworkTxId:
      pickString(row.artworkTxId) ||
      pickString(row.ArtworkTxId) ||
      pickString(row['Artwork-Tx-Id']) ||
      pickString(row['Cover-Art-Tx-Id']) ||
      pickString(row['Thumbnail-Tx-Id']),
    artworkUrl: pickString(row.artworkUrl) || pickString(row.ArtworkUrl),
    contentType: pickString(row.contentType) || pickString(row['Content-Type']),
    udl: normalizedUdl,
    splits: parseSplits(row.splits || row.Splits || row['Royalties-Splits']),
  };
}

/**
 * Playback URL for stored uploads. Prefer `arioUrl` (Turbo CDN / turbo-gateway) when present so
 * fresh Turbo data items play before `arweave.net/{id}` finishes propagating.
 */
export function uploadedTrackShareUrl(track: Pick<UploadedTrackRecord, 'txId' | 'permawebUrl' | 'arioUrl'>): string {
  return track.arioUrl || track.permawebUrl || arweaveTxDataUrl(track.txId);
}

function normalizeText(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function matchUploadedTrackToAudiusTrack(
  uploads: UploadedTrackRecord[],
  track: Pick<Track, 'id' | 'title' | 'artist'>
): UploadedTrackRecord | null {
  const id = String(track.id || '');
  const byId = uploads.find((upload) => upload.audiusTrackId === id);
  if (byId) return byId;
  const title = normalizeText(track.title);
  const artist = normalizeText(track.artist);
  const candidates = uploads.filter(
    (upload) =>
      !upload.audiusTrackId &&
      normalizeText(upload.title) === title &&
      normalizeText(upload.artist) === artist
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function uploadedTrackToPlayerTrack(track: UploadedTrackRecord): Track {
  const artwork = track.artworkTxId
    ? preferredArweaveStreamUrl(track.artworkTxId)
    : track.artworkUrl;
  return {
    id: track.txId,
    title: track.title,
    artist: track.artist || 'Unknown artist',
    artistId: track.walletAddress || track.txId,
    artwork,
    streamUrl: uploadedTrackShareUrl(track),
    isPermanent: true,
    permaTxId: track.txId,
    assetId: track.assetId,
  };
}

/** Keep the Audius track id for UI keys, but play from the persisted Arweave upload when present. */
export function mergeAudiusTrackWithPersistedUpload(audiusTrack: Track, upload: UploadedTrackRecord): Track {
  const p = uploadedTrackToPlayerTrack(upload);
  return {
    ...audiusTrack,
    streamUrl: p.streamUrl,
    artwork: p.artwork ?? audiusTrack.artwork,
    isPermanent: true,
    permaTxId: p.permaTxId,
    assetId: p.assetId ?? audiusTrack.assetId,
  };
}

export function uploadedTrackLicenseBadges(track: UploadedTrackRecord): string[] {
  const badges = trackSourceBadges({ assetId: track.assetId, isPermanent: true });
  if (track.udl?.usage?.length) badges.push(`Use: ${track.udl.usage.join(', ')}`);
  if (track.udl?.aiUse) badges.push(`AI: ${track.udl.aiUse}`);
  if (track.udl?.fee && track.udl?.currency) {
    badges.push(`Fee: ${track.udl.fee} ${track.udl.currency}/${track.udl.interval || 'per-stream'}`);
  }
  return badges;
}

/** Short badges for compact track cards (Permanent + Atomic asset only). */
export function uploadedTrackCompactBadges(track: UploadedTrackRecord): string[] {
  return trackSourceBadges({ assetId: track.assetId, isPermanent: true });
}
