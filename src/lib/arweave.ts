/**
 * Arweave uploads and atomic asset minting for StreamVault.
 * - Free uploads under 100kb (15s sample → data tx or turbo)
 * - Larger files via bundled uploads
 * - Atomic assets via @permaweb/libs createAtomicAsset
 */

const SAMPLE_MAX_BYTES = 100 * 1024; // 100kb
const FULL_MAX_BYTES = 10 * 1024 * 1024; // ~10MB
const SAMPLE_DURATION_SEC = 15;

export type PublishTier = 'sample' | 'full';

export interface SamplePublishOptions {
  tier: 'sample';
  /** Audio blob (e.g. 15s clip), target <100kb */
  data: Blob;
  title: string;
  artistName: string;
  artworkTxId?: string;
}

export interface FullPublishOptions {
  tier: 'full';
  /** Full audio file, up to ~10MB */
  data: Blob;
  title: string;
  description?: string;
  artistName: string;
  creatorAddress: string;
  artworkTxId?: string;
  topics?: string[];
  metadata?: Record<string, unknown>;
}

export type PublishOptions = SamplePublishOptions | FullPublishOptions;

export interface PublishResult {
  success: boolean;
  txId?: string;
  assetId?: string;
  permawebUrl?: string;
  arioUrl?: string;
  confirmed?: boolean;
  gatewayReady?: boolean;
  error?: string;
}

export function isUnderSampleLimit(bytes: number): boolean {
  return bytes <= SAMPLE_MAX_BYTES;
}

export function isUnderFullLimit(bytes: number): boolean {
  return bytes <= FULL_MAX_BYTES;
}

export { SAMPLE_MAX_BYTES, FULL_MAX_BYTES, SAMPLE_DURATION_SEC };
