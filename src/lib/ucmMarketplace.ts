/**
 * UCM marketplace reads + StreamVault discover listings.
 */
import type { Track } from '../context/PlayerContext';
import { queryAudioTransactions, enrichTracksWithAtomicAssetIds, fetchAtomicAssetMap } from './arweaveDiscovery';
import { fetchHyperbeamAssetState } from './hbNode';
import {
  UCM_LEGACY_ORDERBOOK_ID,
  buildUcmDeps,
  fetchSellerAssetBalance,
  resolveAssetOrderbookId,
} from './ucm';
import {
  extractAssetAsksFromInfo,
  readActivityProcessId,
  readDedicatedOrderbookInfo,
  readDedicatedOrderbookInfoDetailed,
  summarizeOrderbookPairs,
  type ParsedUcmAsk,
} from './ucmOrderbookRead';
import { readOrderbookIdFromAssetJson } from './ucmAssetOrderbook';
import {
  discoverActivityIdForOrderbook,
  discoverDedicatedOrderbookIdFromGraphql,
  discoverUcmProcessesFromGraphql,
} from './ucmOrderbookDiscover';
import { resolveCanonicalAtomicAssetId } from './ucmAssetResolve';
import {
  getCachedAssetActivityId,
  getCachedAssetListingAttempt,
  getCachedAssetOrderbookId,
  rememberAssetActivityId,
  rememberAssetOrderbookId,
} from './ucmOrderbookCache';
import { DEFAULT_WAR_TOKEN_ID, getUcmQuoteToken, tokenBaseUnitsToDisplay } from './ucmTokens';

export type UcmActiveOrder = {
  orderId: string;
  orderbookId: string;
  assetId: string;
  quoteToken: string;
  quoteSymbol: string;
  quantity: string;
  priceWinston: string;
  priceDisplay: string;
  /** @deprecated use priceDisplay */
  priceAr: string;
  creator: string;
  side: 'Ask' | 'Bid';
  /** True when asset Balances show orderbook escrow but Orderbook Info has no ask yet. */
  escrowedUnread?: boolean;
};

export type MarketplaceListing = {
  assetId: string;
  audioTxId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  priceDisplay: string;
  /** @deprecated use priceDisplay */
  priceAr: string;
  quoteSymbol: string;
  priceWinston: string;
  quantity: string;
  orderId: string;
  orderbookId: string;
  track: Track;
  escrowedUnread?: boolean;
};

function toUcmActiveOrder(ask: ParsedUcmAsk): UcmActiveOrder {
  return {
    orderId: ask.orderId,
    orderbookId: ask.orderbookId,
    assetId: ask.assetId,
    quoteToken: ask.quoteToken,
    quoteSymbol: ask.quoteSymbol,
    quantity: ask.quantity,
    priceWinston: ask.priceWinston,
    priceDisplay: ask.priceDisplay,
    priceAr: ask.priceDisplay,
    creator: ask.creator,
    side: ask.side,
  };
}

export function isEscrowedUnreadOrderId(orderId: string): boolean {
  return String(orderId || '').startsWith('escrow:');
}

function parseOrderbookEscrowQty(
  balances: unknown,
  orderbookId: string
): number {
  const book = String(orderbookId || '').trim();
  if (!book || balances == null) return 0;
  if (typeof balances === 'object' && !Array.isArray(balances)) {
    const raw = (balances as Record<string, unknown>)[book];
    const n = Number(raw ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return 0;
}

async function readOrderbookEscrowQty(assetId: string, orderbookId: string): Promise<number> {
  const hb = await fetchHyperbeamAssetState(assetId).catch(() => null);
  const json = (hb?.json || null) as Record<string, unknown> | null;
  return parseOrderbookEscrowQty(json?.Balances, orderbookId);
}

function buildEscrowedUnreadOrder(args: {
  assetId: string;
  orderbookId: string;
  quantity: number;
  creator: string;
}): UcmActiveOrder {
  const cached = getCachedAssetListingAttempt(args.assetId);
  const quoteToken =
    String(cached?.quoteTokenId || '').trim() || DEFAULT_WAR_TOKEN_ID;
  const tokenMeta = getUcmQuoteToken(quoteToken);
  const priceDisplay = String(cached?.priceDisplay || '').trim()
    ? String(cached?.priceDisplay).trim()
    : cached?.priceWinston
      ? tokenBaseUnitsToDisplay(cached.priceWinston, tokenMeta?.denomination ?? 12)
      : '—';
  return {
    orderId: `escrow:${args.orderbookId}`,
    orderbookId: args.orderbookId,
    assetId: args.assetId,
    quoteToken,
    quoteSymbol: String(cached?.quoteSymbol || tokenMeta?.symbol || 'TOKEN'),
    quantity: String(Math.max(1, Math.floor(args.quantity))),
    priceWinston: String(cached?.priceWinston || '0'),
    priceDisplay,
    priceAr: priceDisplay,
    creator: args.creator,
    side: 'Ask',
    escrowedUnread: true,
  };
}

/** Dry-run UCM / orderbook process Info (read-only). Prefer readDedicatedOrderbookInfo for micro orderbooks. */
export async function readUcmOrderbookInfo(orderbookId: string): Promise<Record<string, unknown> | null> {
  return readDedicatedOrderbookInfo(orderbookId);
}

export async function readAssetOrderbookId(assetId: string): Promise<string | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;

  const cached = getCachedAssetOrderbookId(id);
  if (cached) return cached;

  const fromGraphql = await discoverDedicatedOrderbookIdFromGraphql(id);
  if (fromGraphql) return fromGraphql;

  const hb = await fetchHyperbeamAssetState(id);
  const fromHb = readOrderbookIdFromAssetJson(hb?.json as Record<string, unknown> | undefined);
  if (fromHb) {
    rememberAssetOrderbookId(id, fromHb);
    return fromHb;
  }

  try {
    const deps = buildUcmDeps(null);
    const res: any = await deps.ao.dryrun({
      process: id,
      tags: [{ name: 'Action', value: 'Info' }],
    });
    const message = res?.Messages?.[0];
    if (message?.Data) {
      const parsed = JSON.parse(message.Data);
      const fromDryrun = readOrderbookIdFromAssetJson(
        parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      );
      if (fromDryrun) {
        rememberAssetOrderbookId(id, fromDryrun);
        return fromDryrun;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

const WALLET_LISTINGS_TIMEOUT_MS = 14_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
}

async function resolveActivityProcessId(
  assetId: string,
  orderbookInfo: Record<string, unknown> | null | undefined,
  orderbookId?: string | null
): Promise<string | null> {
  const fromInfo = readActivityProcessId(orderbookInfo);
  if (fromInfo) {
    rememberAssetActivityId(assetId, fromInfo);
    return fromInfo;
  }
  const cached = getCachedAssetActivityId(assetId);
  if (cached) return cached;

  const obId = String(orderbookId || '').trim();
  if (obId && !orderbookInfo) {
    const info = await readDedicatedOrderbookInfo(obId).catch(() => null);
    const fromFreshInfo = readActivityProcessId(info);
    if (fromFreshInfo) {
      rememberAssetActivityId(assetId, fromFreshInfo);
      return fromFreshInfo;
    }
  }

  const fromGraphql = await discoverUcmProcessesFromGraphql(assetId);
  if (fromGraphql.activityProcessId) return fromGraphql.activityProcessId;

  if (obId) {
    const fromPair = await discoverActivityIdForOrderbook(obId);
    if (fromPair) {
      rememberAssetActivityId(assetId, fromPair);
      return fromPair;
    }
  }

  return null;
}

function assetHasMetadataModel(json: Record<string, unknown> | null | undefined): boolean {
  const meta = json?.Metadata;
  return meta != null && typeof meta === 'object';
}

export type AssetMarketplaceRouting = {
  orderbookId: string;
  source: 'dedicated' | 'legacy';
};

export type AssetUcmMarketStatus = {
  assetId: string;
  orderbookId: string | null;
  activityProcessId: string | null;
  orderbookSource: 'dedicated' | 'legacy' | 'none';
  orderbookIdFromCache: boolean;
  orderbookDiscoveredViaGraphql: boolean;
  metadataOrderbookLinked: boolean;
  orderbookReadSource: 'hb-compute' | 'hb-now' | 'hb-info-post' | 'dryrun' | 'none';
  orderbookReachable: boolean;
  pairSummaries: ReturnType<typeof summarizeOrderbookPairs>;
  totalAskCount: number;
  asks: UcmActiveOrder[];
};

export async function resolveAssetOrderbookIdFast(
  assetId: string,
  hint?: string | null
): Promise<string | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;
  const hinted = String(hint || '').trim();
  if (hinted) {
    rememberAssetOrderbookId(id, hinted);
    return hinted;
  }
  const cached = getCachedAssetOrderbookId(id);
  if (cached) return cached;
  const fromGraphql = await discoverDedicatedOrderbookIdFromGraphql(id);
  return fromGraphql;
}

/** Load orderbook + activity process ids and current asks (for listing UI / debug). */
export async function fetchAssetUcmMarketStatus(
  assetId: string,
  options?: { orderbookIdHint?: string | null }
): Promise<AssetUcmMarketStatus> {
  const canonicalAssetId = await resolveCanonicalAtomicAssetId(assetId);
  const hintedOrderbookId = String(options?.orderbookIdHint || '').trim() || null;

  const discovered = await discoverUcmProcessesFromGraphql(canonicalAssetId);
  let resolvedOrderbookId =
    (await resolveAssetOrderbookIdFast(canonicalAssetId, hintedOrderbookId)) || discovered.orderbookId;
  let metadataOrderbookId: string | null = null;
  let assetHbJson: Record<string, unknown> | null = null;

  if (!resolvedOrderbookId) {
    const hb = await fetchHyperbeamAssetState(canonicalAssetId);
    assetHbJson = (hb?.json || null) as Record<string, unknown> | null;
    metadataOrderbookId = readOrderbookIdFromAssetJson(assetHbJson);
    resolvedOrderbookId = metadataOrderbookId || (await readAssetOrderbookId(canonicalAssetId));
  }

  const orderbookDiscoveredViaGraphql = Boolean(
    resolvedOrderbookId &&
      !metadataOrderbookId &&
      !hintedOrderbookId &&
      !getCachedAssetOrderbookId(canonicalAssetId)
  );
  const orderbookId = resolvedOrderbookId || null;

  if (!orderbookId) {
    if (!assetHbJson) {
      const hb = await fetchHyperbeamAssetState(canonicalAssetId);
      assetHbJson = (hb?.json || null) as Record<string, unknown> | null;
    }
    if (!assetHasMetadataModel(assetHbJson)) {
      const legacyId = UCM_LEGACY_ORDERBOOK_ID;
      const { info, source } = await readDedicatedOrderbookInfoDetailed(legacyId);
      const asks = extractAssetUcmAsksFromInfo(info, canonicalAssetId, legacyId);
      const activityProcessId = await resolveActivityProcessId(canonicalAssetId, info, legacyId);
      return {
        assetId: canonicalAssetId,
        orderbookId: legacyId,
        activityProcessId,
        orderbookSource: 'legacy',
        orderbookIdFromCache: false,
        orderbookDiscoveredViaGraphql: false,
        metadataOrderbookLinked: false,
        orderbookReadSource: source,
        orderbookReachable: Boolean(info),
        pairSummaries: summarizeOrderbookPairs(info, assetId),
        totalAskCount: asks.length,
        asks,
      };
    }

    return {
      assetId: canonicalAssetId,
      orderbookId: null,
      activityProcessId: discovered.activityProcessId,
      orderbookSource: 'none',
      orderbookIdFromCache: false,
      orderbookDiscoveredViaGraphql: false,
      metadataOrderbookLinked: false,
      orderbookReadSource: 'none',
      orderbookReachable: false,
      pairSummaries: [],
      totalAskCount: 0,
      asks: [],
    };
  }

  if (hintedOrderbookId) rememberAssetOrderbookId(canonicalAssetId, orderbookId);

  const orderbookIdFromCache = Boolean(
    !metadataOrderbookId &&
      !hintedOrderbookId &&
      Boolean(getCachedAssetOrderbookId(canonicalAssetId))
  );

  const { info, source } = await readDedicatedOrderbookInfoDetailed(orderbookId);
  const asks = extractAssetUcmAsksFromInfo(info, canonicalAssetId, orderbookId);
  let activityProcessId = discovered.activityProcessId;
  if (!activityProcessId) {
    activityProcessId = await resolveActivityProcessId(canonicalAssetId, info, orderbookId);
  }

  return {
    assetId: canonicalAssetId,
    orderbookId,
    activityProcessId,
    orderbookSource: 'dedicated',
    orderbookIdFromCache,
    orderbookDiscoveredViaGraphql,
    metadataOrderbookLinked: Boolean(metadataOrderbookId),
    orderbookReadSource: source,
    orderbookReachable: Boolean(info),
    pairSummaries: summarizeOrderbookPairs(info, assetId),
    totalAskCount: asks.length,
    asks,
  };
}

/** Resolve which UCM orderbook process holds active listings for this atomic asset. */
export async function resolveAssetMarketplaceOrderbook(
  assetId: string
): Promise<AssetMarketplaceRouting | null> {
  const canonicalAssetId = await resolveCanonicalAtomicAssetId(assetId);
  const dedicated =
    (await resolveAssetOrderbookIdFast(canonicalAssetId)) ||
    (await readAssetOrderbookId(canonicalAssetId));
  if (dedicated) return { orderbookId: dedicated, source: 'dedicated' };

  const hb = await fetchHyperbeamAssetState(canonicalAssetId);
  const json = (hb?.json || null) as Record<string, unknown> | null;
  if (assetHasMetadataModel(json)) return null;
  return { orderbookId: UCM_LEGACY_ORDERBOOK_ID, source: 'legacy' };
}

/** Extract sell-side orders for a music atomic asset from dedicated micro orderbook state. */
export function extractAssetUcmAsksFromInfo(
  info: Record<string, unknown> | null | undefined,
  assetId: string,
  orderbookId: string
): UcmActiveOrder[] {
  return extractAssetAsksFromInfo(info, assetId, orderbookId).map(toUcmActiveOrder);
}

export async function fetchAssetUcmAsks(
  assetId: string,
  orderbookIdHint?: string | null
): Promise<UcmActiveOrder[]> {
  const canonicalAssetId = await resolveCanonicalAtomicAssetId(assetId);
  const hinted = String(orderbookIdHint || '').trim();
  const routing = hinted
    ? ({ orderbookId: hinted, source: 'dedicated' as const })
    : await resolveAssetMarketplaceOrderbook(canonicalAssetId);
  if (!routing) return [];
  if (hinted) rememberAssetOrderbookId(canonicalAssetId, routing.orderbookId);
  const info = await readDedicatedOrderbookInfo(routing.orderbookId);
  return extractAssetUcmAsksFromInfo(info, canonicalAssetId, routing.orderbookId);
}

export type WalletListingsResult = {
  orders: UcmActiveOrder[];
  timedOut?: boolean;
  orderbookReachable?: boolean;
};

export async function fetchWalletListingsForAsset(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  quoteTokenId?: string | null;
  orderbookIdHint?: string | null;
  /** Owner listing UI can surface escrowed transfers; public/profile marketplace views should not. */
  includeEscrowedUnread?: boolean;
}): Promise<WalletListingsResult> {
  const wallet = args.walletAddress.trim();
  if (!wallet) return { orders: [] };

  const hintedOrderbookId =
    String(args.orderbookIdHint || '').trim() ||
    getCachedAssetOrderbookId(args.assetId) ||
    getCachedAssetListingAttempt(args.assetId)?.orderbookId ||
    null;

  return withTimeout(
    (async (): Promise<WalletListingsResult> => {
      const canonicalAssetId = await resolveCanonicalAtomicAssetId(args.assetId);
      // Prefer wallet + profile ids — skip slow Balances identity resolve for Refresh.
      const creators = new Set(
        [wallet, String(args.profileId || '').trim()].filter(Boolean)
      );
      const quoteFilter = String(args.quoteTokenId || '').trim();
      const asks = await fetchAssetUcmAsks(canonicalAssetId, hintedOrderbookId);
      const orders = asks.filter((order) => {
        if (order.side !== 'Ask') return false;
        // Dedicated micro-orderbooks are per-asset; still prefer seller match when Creator is set.
        if (order.creator && creators.size > 0 && !creators.has(order.creator)) return false;
        if (quoteFilter && order.quoteToken !== quoteFilter) return false;
        return true;
      });

      if (orders.length > 0) {
        return { orders, orderbookReachable: true };
      }

      const orderbookId =
        hintedOrderbookId ||
        (await resolveAssetOrderbookIdFast(canonicalAssetId)) ||
        null;
      if (!orderbookId) return { orders: [], orderbookReachable: false };
      if (args.includeEscrowedUnread === false) {
        return { orders: [], orderbookReachable: true };
      }

      const [escrowQty, sellerBal] = await Promise.all([
        readOrderbookEscrowQty(canonicalAssetId, orderbookId),
        fetchSellerAssetBalance({
          assetId: canonicalAssetId,
          walletAddress: wallet,
          profileId: args.profileId,
        }).catch(() => null),
      ]);
      const escrowed =
        escrowQty > 0
          ? escrowQty
          : Math.max(0, Math.floor(sellerBal?.escrowedCopies || 0));
      if (escrowed <= 0) {
        return { orders: [], orderbookReachable: true };
      }

      return {
        orders: [
          buildEscrowedUnreadOrder({
            assetId: canonicalAssetId,
            orderbookId,
            quantity: escrowed,
            creator: wallet,
          }),
        ],
        orderbookReachable: true,
      };
    })(),
    WALLET_LISTINGS_TIMEOUT_MS,
    { orders: [], timedOut: true }
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function listingFromAsk(track: Track, ask: UcmActiveOrder): MarketplaceListing {
  return {
    assetId: ask.assetId,
    audioTxId: track.permaTxId || track.id,
    title: track.title,
    artist: track.artist,
    artworkUrl: track.artwork,
    priceDisplay: ask.priceDisplay,
    priceAr: ask.priceDisplay,
    quoteSymbol: ask.quoteSymbol,
    priceWinston: ask.priceWinston,
    quantity: ask.quantity,
    orderId: ask.orderId,
    orderbookId: ask.orderbookId,
    track,
    escrowedUnread: ask.escrowedUnread,
  };
}

/** Discover StreamVault atomic assets with active UCM sell orders. */
export async function fetchStreamVaultMarketplaceListings(limit = 16): Promise<MarketplaceListing[]> {
  const assetMap = await fetchAtomicAssetMap({ limit: 100 });
  const tracks = await enrichTracksWithAtomicAssetIds(
    await queryAudioTransactions({ limit: 80 }),
    assetMap
  );
  const withAssets = tracks.filter((t) => t.assetId);
  if (!withAssets.length) return [];

  const listingByOrderId = new Map<string, MarketplaceListing>();

  await mapWithConcurrency(withAssets, 4, async (track) => {
    const assetId = track.assetId as string;
    const routing = await resolveAssetMarketplaceOrderbook(assetId);
    if (!routing) return;

    const info = await readDedicatedOrderbookInfo(routing.orderbookId);
    const asks = extractAssetUcmAsksFromInfo(info, assetId, routing.orderbookId);
    for (const ask of asks) {
      if (Number(ask.quantity) <= 0) continue;
      listingByOrderId.set(ask.orderId, listingFromAsk(track, ask));
    }
  });

  return Array.from(listingByOrderId.values())
    .sort((a, b) => Number(b.priceWinston) - Number(a.priceWinston))
    .slice(0, limit);
}

/** Profile / vault: assets with active readable UCM asks for a set of known atomic asset ids. */
export async function fetchListedAssetsForProfile(args: {
  assets: Array<{ assetId: string; track: Track }>;
  walletAddress: string;
  profileId?: string | null;
  limit?: number;
}): Promise<MarketplaceListing[]> {
  const wallet = String(args.walletAddress || '').trim();
  if (!wallet || !args.assets.length) return [];
  const limit = Math.max(1, args.limit ?? 24);
  const listingByKey = new Map<string, MarketplaceListing>();

  await mapWithConcurrency(args.assets.slice(0, 40), 4, async (row) => {
    const assetId = String(row.assetId || '').trim();
    if (!assetId) return;
    const { orders } = await fetchWalletListingsForAsset({
      assetId,
      walletAddress: wallet,
      profileId: args.profileId,
      orderbookIdHint: getCachedAssetOrderbookId(assetId),
      includeEscrowedUnread: false,
    });
    for (const order of orders) {
      listingByKey.set(order.orderId, listingFromAsk(row.track, order));
    }
  });

  return Array.from(listingByKey.values())
    .sort((a, b) => Number(b.priceWinston) - Number(a.priceWinston))
    .slice(0, limit);
}

export async function ensureAssetOrderbookIdForCancel(args: {
  assetId: string;
  walletAddress: string;
}): Promise<string> {
  const existing = await readAssetOrderbookId(args.assetId);
  if (existing) return existing;
  const wallet = (typeof window !== 'undefined' && (window as any).arweaveWallet) || null;
  if (!wallet) throw new Error('Connect Wander to manage UCM listings.');
  const { createDataItemSigner } = await import('@permaweb/aoconnect');
  const deps = buildUcmDeps(createDataItemSigner(wallet));
  return resolveAssetOrderbookId({
    assetId: args.assetId,
    deps,
  });
}
