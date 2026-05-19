import { queryAudioByOwner } from './arweaveDiscovery';
import { readUploadLedger, type UploadLedgerEntry } from './uploadLedger';
import type { Track } from '../context/PlayerContext';
import { uploadedTrackToPlayerTrack } from './uploadedTracks';

export function normalizeWalletAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Arweave (43-char) or EVM (0x + 40 hex) wallet identifiers used in routes. */
export function looksLikeWalletAddress(id: string): boolean {
  const s = id.trim();
  if (/^0x[a-fA-F0-9]{40}$/i.test(s)) return true;
  if (/^[a-zA-Z0-9_-]{43}$/.test(s)) return true;
  return s.length >= 32 && /^[a-zA-Z0-9_-]+$/.test(s);
}

export function arweaveArtistPath(walletAddress: string): string {
  return `/artist/arweave/${encodeURIComponent(normalizeWalletAddress(walletAddress))}`;
}

export function defaultArtistHrefForTrack(track: Track): string | undefined {
  if (track.isPermanent || track.permaTxId) {
    if (track.artistId && looksLikeWalletAddress(track.artistId)) {
      return arweaveArtistPath(track.artistId);
    }
  }
  if (track.artistId && !looksLikeWalletAddress(track.artistId)) {
    return `/artist/${track.artistId}`;
  }
  return undefined;
}

export type ArweaveArtistPageData = {
  walletAddress: string;
  displayName: string;
  tracks: Track[];
  uploads: UploadLedgerEntry[];
};

export async function fetchArweaveArtistPageData(
  rawAddress: string
): Promise<ArweaveArtistPageData> {
  const walletAddress = normalizeWalletAddress(rawAddress);
  const ledger = readUploadLedger([walletAddress]);
  let discovered: Track[] = [];
  try {
    discovered = await queryAudioByOwner(walletAddress, 50);
  } catch {
    discovered = [];
  }

  const trackMap = new Map<string, Track>();
  for (const upload of ledger) {
    trackMap.set(upload.txId, uploadedTrackToPlayerTrack(upload));
  }
  for (const track of discovered) {
    if (!trackMap.has(track.id)) trackMap.set(track.id, track);
  }

  const tracks = Array.from(trackMap.values());
  tracks.sort((a, b) => {
    const aUpload = ledger.find((u) => u.txId === a.permaTxId || u.txId === a.id);
    const bUpload = ledger.find((u) => u.txId === b.permaTxId || u.txId === b.id);
    const aTime = aUpload?.createdAt ? Date.parse(aUpload.createdAt) : 0;
    const bTime = bUpload?.createdAt ? Date.parse(bUpload.createdAt) : 0;
    return bTime - aTime;
  });

  const displayName =
    ledger.find((u) => u.artist?.trim())?.artist ||
    tracks.find((t) => t.artist?.trim())?.artist ||
    `${walletAddress.slice(0, 8)}…${walletAddress.slice(-6)}`;

  return { walletAddress, displayName, tracks, uploads: ledger };
}
