import type { Track } from '../context/PlayerContext';
import type { UploadedTrackRecord } from './uploadedTracks';

/** Badge label for permaweb atomic asset uploads. */
export const ATOMIC_ASSET_BADGE = 'Atomic Asset';

/** Visual tone for source / permanence pills on track tiles. */
export type TrackBadgeTone = 'atomic' | 'permanent' | 'default';

/** Badges for permaweb uploads (discover, profile, track detail). */
export function trackSourceBadges(input: {
  assetId?: string | null;
  isPermanent?: boolean;
}): string[] {
  const badges: string[] = [];
  if (input.isPermanent !== false) badges.push('Permanent');
  if (String(input.assetId || '').trim()) badges.push(ATOMIC_ASSET_BADGE);
  return badges;
}

export function trackHasAtomicAsset(track: Pick<Track, 'assetId'> | Pick<UploadedTrackRecord, 'assetId'>): boolean {
  return Boolean(String(track.assetId || '').trim());
}

/** Map badge / pill copy to a shared color tone used across Discover, Library, and Profile. */
export function trackBadgeTone(label: string): TrackBadgeTone {
  const value = String(label || '').trim().toLowerCase();
  if (
    value === 'atomic asset' ||
    value === 'atomic' ||
    value === 'ucm'
  ) {
    return 'atomic';
  }
  if (
    value === 'permanent' ||
    value === 'on arweave' ||
    value === 'arweave'
  ) {
    return 'permanent';
  }
  return 'default';
}
