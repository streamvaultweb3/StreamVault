export type UdlAiUse = 'allow-train' | 'allow-generate' | 'deny';

export type UdlInterval = 'one-time' | 'per-stream' | 'per-download' | 'per-month';

/**
 * Minimal UDL configuration stored in atomic asset metadata and mirrored in tags.
 * This intentionally stays string-based so it round-trips cleanly through Arweave tags.
 */
export interface UdlConfig {
  /** Identifier for the license template, e.g. udl://music/1.0 */
  licenseId: string;
  /** Arweave tx id (ar://...) or https URL for full license text */
  uri?: string;
  /** Allowed usages such as stream, download, commercial-sync, remix */
  usage: string[];
  /** Whether and how AI systems may use this track */
  aiUse: UdlAiUse;
  /** Numeric fee as a string (e.g. '0', '1', '5') */
  fee: string;
  /** Currency code, e.g. 'U', 'MATIC', 'USDC.base', 'AR' */
  currency: string;
  /** How often the fee applies (per-stream, per-download, etc.) */
  interval: UdlInterval;
  /** Whether attribution is required when using the work */
  attribution?: 'required' | 'optional';
  /** Optional human-readable jurisdiction or notes */
  jurisdiction?: string;
}

export type RoyaltyChain = 'arweave' | 'ethereum' | 'base' | 'polygon' | 'solana';

export interface RoyaltySplit {
  /** Recipient address on the target chain */
  address: string;
  /** Share of the payout in basis points (10_000 = 100%) */
  shareBps: number;
  /** Chain on which royalties are expected to be settled */
  chain: RoyaltyChain;
  /** Token symbol or identifier, e.g. 'U', 'MATIC', 'USDC.base', 'AR' */
  token: string;
}

/** Arweave transaction tags mirroring UDL fields (used on data txs and atomic assets). */
export function udlConfigToTags(udl: UdlConfig): { name: string; value: string }[] {
  return [
    { name: 'License', value: udl.licenseId },
    ...(udl.uri ? [{ name: 'License-URI', value: udl.uri }] : []),
    { name: 'License-Use', value: udl.usage.join(',') },
    { name: 'License-AI-Use', value: udl.aiUse },
    { name: 'License-Fee', value: udl.fee },
    { name: 'License-Fee-Unit', value: udl.interval },
    { name: 'License-Currency', value: udl.currency },
    ...(udl.attribution ? [{ name: 'License-Attribution', value: udl.attribution }] : []),
    ...(udl.jurisdiction ? [{ name: 'License-Jurisdiction', value: udl.jurisdiction }] : []),
  ];
}

