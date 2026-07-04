/**
 * UCM marketplace reads + StreamVault discover listings.
 */
import type { Track } from '../context/PlayerContext';
import { queryAudioTransactions, enrichTracksWithAtomicAssetIds, fetchAtomicAssetMap } from './arweaveDiscovery';
import { fetchHyperbeamAssetState } from './hbNode';
import {
  UCM_LEGACY_ORDERBOOK_ID,
  buildUcmDeps,
  resolveAssetListingIdentity,
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
  getCachedAssetOrderbookId,
  rememberAssetActivityId,
  rememberAssetOrderbookId,
} from './ucmOrderbookCache';

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
};

export async function fetchWalletListingsForAsset(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  quoteTokenId?: string | null;
  orderbookIdHint?: string | null;
}): Promise<WalletListingsResult> {
  const wallet = args.walletAddress.trim();
  if (!wallet) return { orders: [] };

  const hintedOrderbookId =
    String(args.orderbookIdHint || '').trim() ||
    getCachedAssetOrderbookId(args.assetId) ||
    null;

  return withTimeout(
    (async (): Promise<WalletListingsResult> => {
      const canonicalAssetId = await resolveCanonicalAtomicAssetId(args.assetId);
      const listingIdentity = await resolveAssetListingIdentity({
        assetId: canonicalAssetId,
        walletAddress: wallet,
        profileId: args.profileId,
      });
      const creators = new Set(listingIdentity.askCreatorIds);
      const quoteFilter = String(args.quoteTokenId || '').trim();
      const asks = await fetchAssetUcmAsks(canonicalAssetId, hintedOrderbookId);
      const orders = asks.filter((order) => {
        if (!creators.has(order.creator) || order.side !== 'Ask') return false;
        if (quoteFilter && order.quoteToken !== quoteFilter) return false;
        return true;
      });
      return { orders };
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
      listingByOrderId.set(ask.orderId, {
        assetId,
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
      });
    }
  });

  return Array.from(listingByOrderId.values())
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
