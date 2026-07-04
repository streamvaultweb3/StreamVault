/** Persist known per-asset UCM orderbook ids (HB Metadata.OrderbookId can lag after Eval). */

function orderbookKey(assetId: string): string {
  return `streamvault:ucm-orderbook:${String(assetId || '').trim()}`;
}

function activityKey(assetId: string): string {
  return `streamvault:ucm-activity:${String(assetId || '').trim()}`;
}

export function getCachedAssetOrderbookId(assetId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = localStorage.getItem(orderbookKey(assetId))?.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function rememberAssetOrderbookId(assetId: string, orderbookId: string): void {
  const asset = String(assetId || '').trim();
  const book = String(orderbookId || '').trim();
  if (!asset || !book || typeof window === 'undefined') return;
  try {
    localStorage.setItem(orderbookKey(asset), book);
  } catch {
    // ignore quota / private mode
  }
}

export function getCachedAssetActivityId(assetId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = localStorage.getItem(activityKey(assetId))?.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function rememberAssetActivityId(assetId: string, activityProcessId: string): void {
  const asset = String(assetId || '').trim();
  const activity = String(activityProcessId || '').trim();
  if (!asset || !activity || typeof window === 'undefined') return;
  try {
    localStorage.setItem(activityKey(asset), activity);
  } catch {
    // ignore
  }
}

/** Pull orderbook id from UCM listing error text (transfer sent but ask not confirmed yet). */
export function extractOrderbookIdFromUcmMessage(message: string): string | null {
  const text = String(message || '');
  const full = text.match(/orderbook id \(([A-Za-z0-9_-]{40,})\)/i);
  return full?.[1]?.trim() || null;
}

export function markOrderbookSpawnedForAsset(assetId: string, orderbookId: string): void {
  rememberAssetOrderbookId(assetId, orderbookId);
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`streamvault:ucm-orderbook-spawned:${String(assetId || '').trim()}`, '1');
  } catch {
    // ignore
  }
}

export function wasOrderbookSpawnedForAsset(assetId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(`streamvault:ucm-orderbook-spawned:${String(assetId || '').trim()}`) === '1';
  } catch {
    return false;
  }
}
