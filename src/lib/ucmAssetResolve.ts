/**
 * Resolve the canonical atomic-asset process id for UCM reads.
 * Track pages may route by audio data tx id; orderbook spawns tag Asset-ID = atomic asset id.
 */
import { findAtomicAssetIdForAudioTx } from './arweaveDiscovery';
import { normalizeArweaveTxId } from './arweaveDataGateway';
import { findUploadLedgerByTxId } from './uploadLedger';
import { discoverUcmProcessesFromGraphql } from './ucmOrderbookDiscover';
import { getCachedAssetOrderbookId } from './ucmOrderbookCache';

export async function resolveCanonicalAtomicAssetId(input: string): Promise<string> {
  const id = normalizeArweaveTxId(String(input || '').trim());
  if (!id) return String(input || '').trim();

  if (getCachedAssetOrderbookId(id)) return id;

  const direct = await discoverUcmProcessesFromGraphql(id);
  if (direct.orderbookId) return id;

  const fromLedger = findUploadLedgerByTxId(id)?.assetId;
  if (fromLedger) {
    const normalized = normalizeArweaveTxId(fromLedger);
    if (normalized) return normalized;
  }

  const fromAudioLink = await findAtomicAssetIdForAudioTx(id);
  if (fromAudioLink) return normalizeArweaveTxId(fromAudioLink) || fromAudioLink;

  return id;
}
