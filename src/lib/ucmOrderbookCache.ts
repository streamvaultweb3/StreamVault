/** Persist known per-asset UCM orderbook ids (HB Metadata.OrderbookId can lag after Eval). */

function orderbookKey(assetId: string): string {
  return `streamvault:ucm-orderbook:${String(assetId || '').trim()}`;
}

function activityKey(assetId: string): string {
  return `streamvault:ucm-activity:${String(assetId || '').trim()}`;
}

function isValidAoProcessId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.trim());
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
    return isValidAoProcessId(id) ? id : null;
  } catch {
    return null;
  }
}

export function rememberAssetActivityId(assetId: string, activityProcessId: string): void {
  const asset = String(assetId || '').trim();
  const activity = String(activityProcessId || '').trim();
  if (!asset || !isValidAoProcessId(activity) || typeof window === 'undefined') return;
  try {
    localStorage.setItem(activityKey(asset), activity);
  } catch {
    // ignore
  }
}

/** Pull orderbook id from UCM listing error / status text (transfer sent but ask not confirmed yet). */
export function extractOrderbookIdFromUcmMessage(message: string): string | null {
  const text = String(message || '');
  const patterns = [
    /orderbook id \(([A-Za-z0-9_-]{40,})\)/i,
    /Full orderbook id:\s*([A-Za-z0-9_-]{40,})/i,
    /dedicated orderbook\s+([A-Za-z0-9_-]{40,})/i,
    /orderbook\s+([A-Za-z0-9_-]{40,})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const id = match?.[1]?.trim();
    if (id) return id;
  }
  return null;
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

export type CachedListingAttempt = {
  orderbookId: string;
  quoteTokenId: string;
  quoteSymbol: string;
  priceDisplay: string;
  priceWinston: string;
  quantity: string;
  at: number;
};

function listingAttemptKey(assetId: string): string {
  return `streamvault:ucm-last-listing:${String(assetId || '').trim()}`;
}

function orderbookCompatKey(orderbookId: string): string {
  return `streamvault:ucm-orderbook-hb-compat:${String(orderbookId || '').trim()}`;
}

/** Remember the last sell attempt so escrowed-unread UI can show price before ask Info catches up. */
export function rememberAssetListingAttempt(
  assetId: string,
  attempt: Omit<CachedListingAttempt, 'at'>
): void {
  const asset = String(assetId || '').trim();
  if (!asset || typeof window === 'undefined') return;
  try {
    const row: CachedListingAttempt = { ...attempt, at: Date.now() };
    localStorage.setItem(listingAttemptKey(asset), JSON.stringify(row));
  } catch {
    // ignore
  }
}

export function getCachedAssetListingAttempt(assetId: string): CachedListingAttempt | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(listingAttemptKey(assetId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedListingAttempt;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!String(parsed.orderbookId || '').trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function wasOrderbookHbCompatPatched(orderbookId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(orderbookCompatKey(orderbookId)) === '1';
  } catch {
    return false;
  }
}

export function markOrderbookHbCompatPatched(orderbookId: string): void {
  const id = String(orderbookId || '').trim();
  if (!id || typeof window === 'undefined') return;
  try {
    localStorage.setItem(orderbookCompatKey(id), '1');
  } catch {
    // ignore
  }
}
