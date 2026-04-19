import { normalizeUploadedTrackRecord, type UploadedTrackRecord } from './uploadedTracks';

/**
 * Append-only ledger of publishes on this browser so Profile can show uploads
 * even when the connected wallet (e.g. EVM for Turbo) differs from the Arweave
 * profile address, or when addToZone fails / is not used.
 */

export type UploadLedgerEntry = UploadedTrackRecord & {
  /** Wallet address used at publish time (any chain). */
  walletAddress: string;
};

const LEDGER_KEY = 'streamvault:uploadLedger';
const MAX_ENTRIES = 200;

function normalizeAddr(a: string) {
  return a.trim().toLowerCase();
}

export function appendUploadLedger(entry: UploadLedgerEntry): void {
  if (typeof window === 'undefined' || !entry.txId || !entry.walletAddress) return;
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    const list = (raw ? JSON.parse(raw) : []) as UploadLedgerEntry[];
    const next = [
      { ...entry, walletAddress: normalizeAddr(entry.walletAddress) },
      ...list.filter((e) => e.txId !== entry.txId),
    ].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[uploadLedger] append failed', e);
  }
}

/** Entries for any of the given wallet addresses (dedupe by txId). */
export function readUploadLedger(walletAddresses: (string | null | undefined)[]): UploadLedgerEntry[] {
  if (typeof window === 'undefined') return [];
  const want = new Set(
    walletAddresses.filter(Boolean).map((a) => normalizeAddr(a as string))
  );
  if (want.size === 0) return [];
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    const list = (raw ? JSON.parse(raw) : []) as UploadLedgerEntry[];
    const seen = new Set<string>();
    const out: UploadLedgerEntry[] = [];
    for (const e of list) {
      const normalized = normalizeUploadedTrackRecord(e);
      const walletAddress = typeof e?.walletAddress === 'string' ? e.walletAddress : normalized?.walletAddress;
      if (!normalized?.txId || !walletAddress) continue;
      if (!want.has(normalizeAddr(walletAddress))) continue;
      if (seen.has(normalized.txId)) continue;
      seen.add(normalized.txId);
      out.push({ ...normalized, walletAddress: normalizeAddr(walletAddress) });
    }
    return out;
  } catch {
    return [];
  }
}
