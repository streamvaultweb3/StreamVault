/** Read Metadata.OrderbookId from atomic asset state (HB / dryrun shapes). */

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readOrderbookIdFromAssetJson(
  json: Record<string, unknown> | null | undefined
): string | null {
  if (!json) return null;

  const meta = json.Metadata;
  if (meta && typeof meta === 'object') {
    const fromMeta =
      pickString((meta as Record<string, unknown>).OrderbookId) ||
      pickString((meta as Record<string, unknown>).orderbookId);
    if (fromMeta) return fromMeta;
  }

  const token = json.Token;
  if (token && typeof token === 'object') {
    const fromToken =
      pickString((token as Record<string, unknown>).OrderbookId) ||
      pickString((token as Record<string, unknown>).orderbookId);
    if (fromToken) return fromToken;
  }

  return pickString(json.OrderbookId) || pickString(json.orderbookId) || null;
}
