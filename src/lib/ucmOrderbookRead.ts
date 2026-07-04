/**
 * Read dedicated per-asset UCM micro orderbooks (Bazar-compatible).
 * Bazar: libs.readState({ processId: orderbookId, path: 'orderbook' }) → nested orderbook.Orderbook / Pair / Asks.
 */
import { connect } from '@permaweb/aoconnect';
import { resolveAoNode, resolveHbReadNodeUrls, BAZAR_HB_NODE } from './aoNode';
import {
  HB_READ_HEADERS,
  hbRequest,
  isHyperbeamReadFailure,
} from './hbNode';
import { DEFAULT_WAR_TOKEN_ID, getUcmQuoteToken, tokenBaseUnitsToDisplay } from './ucmTokens';

export type ParsedUcmAsk = {
  orderId: string;
  orderbookId: string;
  assetId: string;
  quoteToken: string;
  quoteSymbol: string;
  quantity: string;
  priceWinston: string;
  priceDisplay: string;
  creator: string;
  side: 'Ask' | 'Bid';
};

type RawUcmOrder = {
  Id?: string;
  id?: string;
  Creator?: string;
  creator?: string;
  Quantity?: string;
  quantity?: string;
  Price?: string;
  price?: string;
  Token?: string;
  token?: string;
};

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAddr(addr: string | undefined | null): string {
  return String(addr || '').trim();
}

function normalizeOrderId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function parseInfoData(message: { Data?: string } | undefined): Record<string, unknown> | null {
  if (!message?.Data) return null;
  try {
    const parsed = JSON.parse(message.Data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Unwrap micro orderbook payload from HB compute / Info (matches Bazar asset page reads). */
export function normalizeUcmOrderbookInfo(
  info: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!info || typeof info !== 'object') return null;

  let row: Record<string, unknown> = info;

  const nested = row.orderbook ?? row.OrderbookState;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const inner = nested as Record<string, unknown>;
    if (
      inner.Orderbook != null ||
      inner.orderbook != null ||
      inner.Pair != null ||
      inner.pair != null ||
      inner.Asks != null ||
      inner.asks != null
    ) {
      row = inner;
    }
  }

  const book = row.Orderbook ?? row.orderbook;
  if (book && typeof book === 'object' && !Array.isArray(book)) {
    const single = book as Record<string, unknown>;
    if (single.Pair || single.pair || single.Asks || single.asks) {
      return { ...row, Orderbook: [single] };
    }
  }

  return row;
}

export function hasOrderbookPayload(json: unknown): boolean {
  const row = normalizeUcmOrderbookInfo(json as Record<string, unknown> | null);
  if (!row) return false;
  return Boolean(
    row.ActivityProcess ||
      row.activityProcess ||
      row.Orderbook ||
      row.orderbook ||
      row.Asks ||
      row.asks ||
      row.Pair ||
      row.pair ||
      row.Orders ||
      row.orders
  );
}

function extractOrderbookFromCompute(json: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null;
  const nested = json.orderbook;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return normalizeUcmOrderbookInfo(nested as Record<string, unknown>);
  }
  return normalizeUcmOrderbookInfo(json);
}

function isHbExecutionFailure(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const row = json as Record<string, unknown>;
  if (typeof row.Error === 'string' && row.Error.trim()) return true;
  if (typeof row.error === 'string' && row.error.trim()) return true;
  return false;
}

function parseOrderbookInfoFromHbExecution(json: Record<string, unknown>): Record<string, unknown> | null {
  const fromCompute = extractOrderbookFromCompute(json);
  if (fromCompute && hasOrderbookPayload(fromCompute)) return fromCompute;
  const normalized = normalizeUcmOrderbookInfo(json);
  if (normalized && hasOrderbookPayload(normalized)) return normalized;
  return null;
}

export function readActivityProcessId(info: Record<string, unknown> | null | undefined): string | null {
  const row = normalizeUcmOrderbookInfo(info);
  if (!row) return null;
  return pickString(row.ActivityProcess) || pickString(row.activityProcess) || null;
}

export type OrderbookPairSummary = {
  base: string;
  quote: string;
  askCount: number;
  bidCount: number;
};

export function summarizeOrderbookPairs(
  info: Record<string, unknown> | null | undefined,
  assetId: string
): OrderbookPairSummary[] {
  const normalized = normalizeUcmOrderbookInfo(info);
  if (!normalized) return [];

  const rows: OrderbookPairSummary[] = [];
  const pushPair = (pairRow: Record<string, unknown>) => {
    const pair = pairRow.Pair ?? pairRow.pair;
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') return;
    if (pair[0] !== assetId) return;
    const asks = pairRow.Asks ?? pairRow.asks;
    const bids = pairRow.Bids ?? pairRow.bids;
    rows.push({
      base: pair[0],
      quote: pair[1],
      askCount: Array.isArray(asks) ? asks.length : 0,
      bidCount: Array.isArray(bids) ? bids.length : 0,
    });
  };

  pushPair(normalized);

  const orderbook = normalized.Orderbook ?? normalized.orderbook;
  const entries = Array.isArray(orderbook) ? orderbook : orderbook ? [orderbook] : [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object') pushPair(entry as Record<string, unknown>);
  }

  return rows;
}

async function dryrunOrderbookInfo(orderbookId: string): Promise<Record<string, unknown> | null> {
  if (!orderbookId.trim()) return null;
  try {
    const node = resolveAoNode();
    const ao = connect({
      MODE: 'mainnet',
      URL: node.url,
      SCHEDULER: node.scheduler,
    } as any);
    const res: any = await ao.dryrun({
      process: orderbookId,
      tags: [{ name: 'Action', value: 'Info' }],
    });
    return normalizeUcmOrderbookInfo(parseInfoData(res?.Messages?.[0]));
  } catch {
    return null;
  }
}

async function readOrderbookInfoPost(orderbookId: string): Promise<Record<string, unknown> | null> {
  for (const nodeBase of resolveHbReadNodeUrls()) {
    try {
      const base = nodeBase.replace(/\/+$/, '');
      const url = `${base}/${orderbookId}~process@1.0/as=execution/compute&Action=Info`;
      const res = await hbRequest({
        label: 'hb-orderbook:Info',
        url,
        method: 'POST',
        headers: HB_READ_HEADERS,
      });
      if (!res.json || isHyperbeamReadFailure(res.json, res.text) || isHbExecutionFailure(res.json)) {
        continue;
      }
      const normalized = parseOrderbookInfoFromHbExecution(res.json as Record<string, unknown>);
      if (normalized) return normalized;
    } catch {
      // try next node
    }
  }
  return null;
}

export type DedicatedOrderbookRead = {
  info: Record<string, unknown> | null;
  source: 'hb-compute' | 'hb-now' | 'hb-info-post' | 'dryrun' | 'none';
};

/** Read a dedicated per-asset orderbook process (not the legacy global UCM). */
export async function readDedicatedOrderbookInfo(
  orderbookId: string
): Promise<Record<string, unknown> | null> {
  const result = await readDedicatedOrderbookInfoDetailed(orderbookId);
  return result.info;
}

/** Same as readDedicatedOrderbookInfo but includes which read path succeeded (for debugging). */
const ORDERBOOK_READ_TIMEOUT_MS = 14_000;

async function readDedicatedOrderbookInfoDetailedInner(
  orderbookId: string
): Promise<DedicatedOrderbookRead> {
  if (!orderbookId.trim()) return { info: null, source: 'none' };

  const fromDryrun = await dryrunOrderbookInfo(orderbookId);
  if (fromDryrun) return { info: fromDryrun, source: 'dryrun' };

  const fromPost = await readOrderbookInfoPost(orderbookId);
  if (fromPost) return { info: fromPost, source: 'hb-info-post' };

  for (const subpath of ['compute', 'now'] as const) {
    const nodeBases = [
      BAZAR_HB_NODE,
      ...resolveHbReadNodeUrls().filter((url) => url.replace(/\/+$/, '') !== BAZAR_HB_NODE.replace(/\/+$/, '')),
    ];
    for (const nodeBase of nodeBases) {
      const base = nodeBase.replace(/\/+$/, '');
      const url = `${base}/${orderbookId}~process@1.0/${subpath}`;
      try {
        const res = await hbRequest({
          label: `hb-orderbook:${subpath}`,
          url,
          method: 'GET',
          headers: HB_READ_HEADERS,
        });
        if (!res.json || isHyperbeamReadFailure(res.json, res.text)) continue;
        const normalized = extractOrderbookFromCompute(res.json as Record<string, unknown>);
        if (normalized) {
          return { info: normalized, source: subpath === 'now' ? 'hb-now' : 'hb-compute' };
        }
      } catch {
        // try next node
      }
    }
  }

  return { info: null, source: 'none' };
}

export async function readDedicatedOrderbookInfoDetailed(
  orderbookId: string
): Promise<DedicatedOrderbookRead> {
  if (!orderbookId.trim()) return { info: null, source: 'none' };
  return Promise.race([
    readDedicatedOrderbookInfoDetailedInner(orderbookId),
    new Promise<DedicatedOrderbookRead>((resolve) => {
      setTimeout(() => resolve({ info: null, source: 'none' }), ORDERBOOK_READ_TIMEOUT_MS);
    }),
  ]);
}

function mapRawAsk(
  raw: RawUcmOrder,
  args: { assetId: string; orderbookId: string; quoteToken: string }
): ParsedUcmAsk | null {
  const orderId = pickString(raw.Id) || pickString(raw.id);
  const quantity = pickString(raw.Quantity) || pickString(raw.quantity) || '0';
  const priceWinston = pickString(raw.Price) || pickString(raw.price) || '0';
  const creator = pickString(raw.Creator) || pickString(raw.creator) || '';
  if (!orderId) return null;
  if (Number(quantity) <= 0) return null;
  const quoteToken = pickString(raw.Token) || pickString(raw.token) || args.quoteToken;
  const tokenMeta = getUcmQuoteToken(quoteToken);
  const priceDisplay = tokenBaseUnitsToDisplay(priceWinston, tokenMeta?.denomination ?? 12);
  return {
    orderId,
    orderbookId: args.orderbookId,
    assetId: args.assetId,
    quoteToken,
    quoteSymbol: tokenMeta?.symbol || 'TOKEN',
    quantity,
    priceWinston,
    priceDisplay,
    creator,
    side: 'Ask',
  };
}

function mapAskList(
  orders: unknown,
  args: { assetId: string; orderbookId: string; quoteToken: string }
): ParsedUcmAsk[] {
  if (!Array.isArray(orders)) return [];
  const out: ParsedUcmAsk[] = [];
  for (const row of orders) {
    if (!row || typeof row !== 'object') continue;
    const mapped = mapRawAsk(row as RawUcmOrder, args);
    if (mapped) out.push(mapped);
  }
  return out;
}

function appendPairAsks(
  out: ParsedUcmAsk[],
  pairRow: Record<string, unknown>,
  assetId: string,
  orderbookId: string,
  defaultQuote: string
): void {
  const pair = pairRow.Pair ?? pairRow.pair;
  const base = Array.isArray(pair) && typeof pair[0] === 'string' ? pair[0] : null;
  if (base && base !== assetId) return;
  const pairQuote = Array.isArray(pair) && typeof pair[1] === 'string' ? pair[1] : defaultQuote;
  const asks = pairRow.Asks ?? pairRow.asks ?? pairRow.Orders ?? pairRow.orders;
  out.push(
    ...mapAskList(asks, {
      assetId: base || assetId,
      orderbookId,
      quoteToken: pairQuote,
    })
  );
}

/** Extract sell-side orders from a dedicated micro orderbook Info / HB payload. */
export function extractAssetAsksFromInfo(
  info: Record<string, unknown> | null | undefined,
  assetId: string,
  orderbookId: string
): ParsedUcmAsk[] {
  const normalized = normalizeUcmOrderbookInfo(info);
  if (!normalized) return [];

  const defaultQuote = DEFAULT_WAR_TOKEN_ID;
  const out: ParsedUcmAsk[] = [];

  appendPairAsks(out, normalized, assetId, orderbookId, defaultQuote);

  const directAsks = normalized.Asks ?? normalized.asks;
  out.push(
    ...mapAskList(directAsks, { assetId, orderbookId, quoteToken: defaultQuote })
  );

  const orderbook = normalized.Orderbook ?? normalized.orderbook;
  const entries = Array.isArray(orderbook) ? orderbook : orderbook ? [orderbook] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    appendPairAsks(out, entry as Record<string, unknown>, assetId, orderbookId, defaultQuote);
  }

  return out;
}

function askMatchesSeller(
  ask: Record<string, unknown>,
  creators: Set<string>,
  orderId?: string | null
): boolean {
  if (orderId) {
    const target = normalizeOrderId(orderId);
    const candidate = normalizeOrderId(ask.Id ?? ask.id);
    if (target && candidate && target === candidate) return true;
  }
  const creator = normalizeAddr(
    (typeof ask.Creator === 'string' && ask.Creator) ||
      (typeof ask.creator === 'string' && ask.creator) ||
      ''
  );
  const qty = Number(ask.Quantity ?? ask.quantity ?? 0);
  return creators.has(creator) && Number.isFinite(qty) && qty > 0;
}

/** True when seller ask exists on the dedicated orderbook (post-list confirmation). */
export function findSellerAskInOrderbookInfo(
  info: Record<string, unknown> | null | undefined,
  args: {
    assetId: string;
    askCreatorIds: string[];
    quoteTokenId?: string | null;
    orderId?: string | null;
  }
): boolean {
  const normalized = normalizeUcmOrderbookInfo(info);
  if (!normalized) return false;

  const creators = new Set(args.askCreatorIds.map((id) => normalizeAddr(id)).filter(Boolean));
  const quoteFilter = normalizeAddr(args.quoteTokenId);

  const askMatchesPair = (ask: Record<string, unknown>, pairQuote?: string | null): boolean => {
    if (!askMatchesSeller(ask, creators, args.orderId)) return false;
    if (!quoteFilter) return true;
    const token = normalizeAddr(
      (typeof ask.Token === 'string' && ask.Token) ||
        (typeof ask.token === 'string' && ask.token) ||
        pairQuote ||
        ''
    );
    return !token || token === quoteFilter;
  };

  const scanPairRow = (row: Record<string, unknown>): boolean => {
    const pair = row.Pair ?? row.pair;
    const base = Array.isArray(pair) && typeof pair[0] === 'string' ? pair[0] : null;
    if (base && base !== args.assetId) return false;
    const pairQuote = Array.isArray(pair) && typeof pair[1] === 'string' ? pair[1] : null;
    if (quoteFilter && pairQuote && normalizeAddr(pairQuote) !== quoteFilter) return false;

    for (const key of ['Asks', 'asks', 'Orders', 'orders'] as const) {
      const asks = row[key];
      if (!Array.isArray(asks)) continue;
      for (const ask of asks) {
        if (!ask || typeof ask !== 'object') continue;
        if (askMatchesPair(ask as Record<string, unknown>, pairQuote)) return true;
      }
    }
    return false;
  };

  if (scanPairRow(normalized)) return true;

  const orderbook = normalized.Orderbook ?? normalized.orderbook;
  const entries = Array.isArray(orderbook) ? orderbook : orderbook ? [orderbook] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (scanPairRow(entry as Record<string, unknown>)) return true;
  }

  return false;
}
