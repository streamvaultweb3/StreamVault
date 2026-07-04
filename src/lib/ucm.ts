/**
 * Universal Content Marketplace (UCM) listing via @permaweb/ucm.
 * Aligns with Bazar / permaweb/ao-ucm: Transfer to dominant token → UCM orderbook.
 */
import { connect, createDataItemSigner } from '@permaweb/aoconnect';
import { cancelOrder, createOrder, createOrderbook } from '@permaweb/ucm';
import { resolveAoNode } from './aoNode';
import { fetchHyperbeamAssetState } from './hbNode';
import { hydrateProcessOnPortalAndBazar } from './hbHydration';
import {
  findSellerAskInOrderbookInfo,
  readActivityProcessId,
  readDedicatedOrderbookInfo,
} from './ucmOrderbookRead';
import { readOrderbookIdFromAssetJson } from './ucmAssetOrderbook';
import {
  getCachedAssetOrderbookId,
  markOrderbookSpawnedForAsset,
  rememberAssetActivityId,
  rememberAssetOrderbookId,
  wasOrderbookSpawnedForAsset,
} from './ucmOrderbookCache';
import { discoverDedicatedOrderbookIdFromGraphql } from './ucmOrderbookDiscover';
import {
  getDefaultUcmQuoteToken,
  getUcmQuoteToken,
  tokenDisplayToBaseUnits,
  DEFAULT_WAR_TOKEN_ID,
} from './ucmTokens';

/** Mainnet wAR (Wrapped AR) — Bazar production default. */
export const WAR_TOKEN_ID = DEFAULT_WAR_TOKEN_ID;

/** Legacy global UCM orderbook fallback (pre per-asset orderbooks). */
export const UCM_LEGACY_ORDERBOOK_ID =
  (import.meta.env.VITE_AO_UCM_PROCESS as string | undefined)?.trim() ||
  'hqdL4AZaFZ0huQHbAsYxdTwG6vpibK7ALWKNzmWaD4Q';

export const WAR_DENOMINATION = 12;
export const ASSET_DENOMINATION = 1;

export type UcmListingStatus = {
  processing: boolean;
  success: boolean;
  message: string;
};

export type UcmListingResult = {
  orderId: string;
  orderbookId: string;
};

function getInjectedWallet(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).arweaveWallet || null;
}

export function ucmConfigured(): boolean {
  return Boolean(WAR_TOKEN_ID && UCM_LEGACY_ORDERBOOK_ID);
}

export function ucmLegacyOrderbookId(): string {
  return UCM_LEGACY_ORDERBOOK_ID;
}

export function bazarAssetUrl(assetId: string): string {
  return `https://bazar.arweave.net/#/asset/${encodeURIComponent(assetId.trim())}`;
}

export function buildUcmDeps(signer?: ReturnType<typeof createDataItemSigner> | null) {
  const node = resolveAoNode();
  const config: Record<string, unknown> = {
    MODE: 'mainnet',
    URL: node.url,
    SCHEDULER: node.scheduler,
  };
  if (signer) config.signer = signer;
  return {
    ao: connect(config as any),
    ...(signer ? { signer } : {}),
  };
}

function pickOrderbookIdFromHb(json: Record<string, unknown> | null | undefined): string | null {
  return readOrderbookIdFromAssetJson(json);
}

function ucmStatusCallback(
  onStatus: ((status: UcmListingStatus) => void) | undefined,
  fallback: string
) {
  return (args: UcmListingStatus) => {
    onStatus?.({
      processing: args.processing,
      success: args.success,
      message: args.message || fallback,
    });
  };
}

/** Resolve or spawn a per-asset UCM orderbook (writes OrderbookId to asset metadata when new).
 *
 * First listing calls @permaweb/ucm `createOrderbook`, which uses permaweb-libs to:
 * 1. Spawn a dedicated Orderbook AO process for this asset
 * 2. Spawn a paired Activity AO process (trade history / indexing)
 * 3. Link Activity ↔ Orderbook via Eval
 * 4. Write `Metadata.OrderbookId` on the atomic asset when `writeToAsset: true`
 *
 * Subsequent listings and marketplace reads use that per-asset orderbook — not the legacy global UCM.
 */
export async function resolveAssetOrderbookId(args: {
  assetId: string;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<string> {
  const cached = getCachedAssetOrderbookId(args.assetId);
  if (cached) return cached;

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Looking up dedicated orderbook for this asset…',
  });

  const hb = await withBalanceTimeout(fetchHyperbeamAssetState(args.assetId));
  let fromMeta = pickOrderbookIdFromHb(hb?.json as Record<string, unknown> | undefined);
  if (!fromMeta) {
    fromMeta = await readAssetOrderbookIdDryrun(args.assetId, args.deps).catch(() => null);
  }
  if (fromMeta) {
    rememberAssetOrderbookId(args.assetId, fromMeta);
    return fromMeta;
  }

  const fromGraphql = await discoverDedicatedOrderbookIdFromGraphql(args.assetId).catch(() => null);
  if (fromGraphql) return fromGraphql;

  if (wasOrderbookSpawnedForAsset(args.assetId)) {
    throw new Error(
      'Dedicated orderbook was already spawned for this asset but Metadata.OrderbookId is not readable yet. ' +
        'Refresh the page — StreamVault caches the orderbook id after listing.'
    );
  }

  args.onStatus?.({ processing: true, success: false, message: 'Creating dedicated UCM orderbook for this asset…' });
  const orderbookId = await createOrderbook(
    args.deps,
    { assetId: args.assetId, writeToAsset: true },
    ucmStatusCallback(args.onStatus, 'Dedicated orderbook ready.')
  );
  if (!orderbookId) throw new Error('UCM orderbook creation returned no id.');

  rememberAssetOrderbookId(args.assetId, orderbookId);
  markOrderbookSpawnedForAsset(args.assetId, orderbookId);

  await waitForAssetOrderbookLink({
    assetId: args.assetId,
    orderbookId,
    deps: args.deps,
    onStatus: args.onStatus,
  });

  return orderbookId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readAssetOrderbookIdDryrun(
  assetId: string,
  deps: ReturnType<typeof buildUcmDeps>
): Promise<string | null> {
  const res: any = await deps.ao.dryrun({
    process: assetId,
    tags: [{ name: 'Action', value: 'Info' }],
  });
  const json = parseInfoData(res?.Messages?.[0]);
  return pickOrderbookIdFromHb(json);
}

/** Poll until Metadata.OrderbookId is readable (HB / dryrun can lag after Eval). */
async function waitForAssetOrderbookLink(args: {
  assetId: string;
  orderbookId: string;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<void> {
  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Linking orderbook to asset metadata…',
  });

  for (let attempt = 0; attempt < 30; attempt++) {
    const hb = await fetchHyperbeamAssetState(args.assetId);
    const fromHb = pickOrderbookIdFromHb(hb?.json as Record<string, unknown> | undefined);
    if (fromHb === args.orderbookId) return;

    const fromDryrun = await readAssetOrderbookIdDryrun(args.assetId, args.deps).catch(() => null);
    if (fromDryrun === args.orderbookId) return;

    await sleep(2000);
  }

  // Metadata.OrderbookId can lag on HyperBEAM; listing still uses the spawned orderbook id.
  args.onStatus?.({
    processing: true,
    success: false,
    message:
      'Orderbook spawned — Metadata.OrderbookId not on HyperBEAM yet. Using cached orderbook id for listings.',
  });
}

function uniqueAddrs(ids: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = normalizeAddr(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function readCreatorFromJson(json: Record<string, unknown> | null | undefined): string {
  if (!json) return '';
  return normalizeAddr(
    typeof json.Creator === 'string'
      ? json.Creator
      : typeof json.creator === 'string'
        ? json.creator
        : null
  );
}

function parseBalanceActionResponse(message: { Data?: string; Tags?: { name: string; value: string }[] } | undefined): number {
  const fromData = parseInfoData(message);
  if (fromData) {
    const raw = fromData.Balance ?? fromData.balance;
    const n = Number(raw ?? 0);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  if (Array.isArray(message?.Tags)) {
    for (const tag of message.Tags) {
      if (tag?.name === 'Balance' && tag.value != null) {
        const n = Number(tag.value);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    }
  }
  return 0;
}

async function readHolderBalanceViaDryrun(
  assetId: string,
  holderId: string,
  deps: ReturnType<typeof buildUcmDeps>
): Promise<number> {
  const holder = normalizeAddr(holderId);
  if (!holder) return 0;
  try {
    const res: any = await deps.ao.dryrun({
      process: assetId,
      tags: [
        { name: 'Action', value: 'Balance' },
        { name: 'Recipient', value: holder },
      ],
    });
    return parseBalanceActionResponse(res?.Messages?.[0]);
  } catch {
    return 0;
  }
}

async function readAssetHolderBalances(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  deps?: ReturnType<typeof buildUcmDeps>;
}): Promise<{ walletCopies: number; profileCopies: number; creator: string; totalSupply: number }> {
  const wallet = normalizeAddr(args.walletAddress);
  const profileId = normalizeAddr(args.profileId) || null;
  const deps = args.deps ?? buildUcmDeps(null);

  const readSplit = (json: Record<string, unknown> | null | undefined) => {
    if (!json) return { wallet: 0, profile: 0 };
    const balances = json.Balances ?? json.balances;
    const token = json.Token;
    const tokenBalances =
      token && typeof token === 'object'
        ? (token as Record<string, unknown>).Balances ?? (token as Record<string, unknown>).balances
        : null;
    const map = balances ?? tokenBalances;
    return {
      wallet: parseBalanceMap(map, wallet),
      profile: profileId ? parseBalanceMap(map, profileId) : 0,
    };
  };

  const hb = await withBalanceTimeout(fetchHyperbeamAssetState(args.assetId));
  const hbJson = (hb?.json || null) as Record<string, unknown> | null;
  let dryrunJson: Record<string, unknown> | null = null;
  try {
    const res: any = await withBalanceTimeout(
      deps.ao.dryrun({
        process: args.assetId,
        tags: [{ name: 'Action', value: 'Info' }],
      })
    );
    if (res) dryrunJson = parseInfoData(res?.Messages?.[0]);
  } catch {
    // dryrun can lag on fresh mints
  }

  const fromHb = readSplit(hbJson);
  const fromDry = readSplit(dryrunJson);
  let walletCopies = Math.max(fromHb.wallet, fromDry.wallet);
  let profileCopies = Math.max(fromHb.profile, fromDry.profile);

  if (wallet) {
    walletCopies = Math.max(walletCopies, await readHolderBalanceViaDryrun(args.assetId, wallet, deps));
  }
  if (profileId) {
    profileCopies = Math.max(profileCopies, await readHolderBalanceViaDryrun(args.assetId, profileId, deps));
  }

  const creator = readCreatorFromJson(hbJson) || readCreatorFromJson(dryrunJson) || wallet;
  const totalSupply = Math.max(readTotalSupply(hbJson), readTotalSupply(dryrunJson));

  return { walletCopies, profileCopies, creator, totalSupply };
}

export async function resolveAssetListingIdentity(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  profileHasAsset?: boolean;
  quantity?: number;
  isLegacyProfile?: boolean;
  deps?: ReturnType<typeof buildUcmDeps>;
}): Promise<AssetListingIdentity> {
  const wallet = normalizeAddr(args.walletAddress);
  const profileId = normalizeAddr(args.profileId) || null;
  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const isLegacyProfile = Boolean(args.isLegacyProfile);
  const profileHasAsset = Boolean(args.profileHasAsset);

  const { walletCopies, profileCopies, creator } = await readAssetHolderBalances({
    assetId: args.assetId,
    walletAddress: wallet,
    profileId,
    deps: args.deps,
  });

  const askCreatorIds = uniqueAddrs([wallet, creator, profileId]);
  const profileListingAction = isLegacyProfile ? 'Transfer' : 'Run-Action';
  const profileOriginated = Boolean(profileId && (creator === profileId || profileHasAsset));

  if (profileId && (profileOriginated || profileCopies >= qty)) {
    const walletToProfileTransferQty =
      profileOriginated || profileCopies >= qty
        ? 0
        : walletCopies > 0
          ? Math.min(walletCopies, Math.max(0, qty - profileCopies))
          : 0;
    return {
      walletAddress: wallet,
      assetCreator: creator || profileId,
      profileId,
      balanceHolderId: profileId,
      listingCreatorId: profileId,
      listingAction: profileListingAction,
      walletToProfileTransferQty,
      askCreatorIds,
    };
  }

  if (walletCopies >= qty) {
    return {
      walletAddress: wallet,
      assetCreator: creator || wallet,
      profileId,
      balanceHolderId: wallet,
      askCreatorIds,
    };
  }

  if (profileId) {
    const walletToProfileTransferQty =
      walletCopies > 0
        ? Math.min(walletCopies, Math.max(0, qty - profileCopies))
        : 0;
    return {
      walletAddress: wallet,
      assetCreator: creator || wallet,
      profileId,
      balanceHolderId: profileId,
      listingCreatorId: profileId,
      listingAction: profileListingAction,
      walletToProfileTransferQty,
      askCreatorIds,
    };
  }

  return {
    walletAddress: wallet,
    assetCreator: creator || wallet,
    profileId: null,
    balanceHolderId: wallet,
    askCreatorIds,
  };
}

async function assertProfileZoneCanList(args: {
  assetId: string;
  walletAddress: string;
  profileId: string;
  quantity: number;
  deps: ReturnType<typeof buildUcmDeps>;
}): Promise<{ walletCopies: number; profileCopies: number; walletToProfileTransferQty: number }> {
  const { walletCopies, profileCopies } = await readAssetHolderBalances({
    assetId: args.assetId,
    walletAddress: args.walletAddress,
    profileId: args.profileId,
    deps: args.deps,
  });
  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const walletToProfileTransferQty =
    profileCopies >= qty ? 0 : Math.max(0, Math.min(walletCopies, qty - profileCopies));
  if (profileCopies + walletCopies < qty) {
    throw new Error(
      `Profile zone holds ${profileCopies} and wallet holds ${walletCopies} — need ${qty} to list.`
    );
  }
  return { walletCopies, profileCopies, walletToProfileTransferQty };
}

async function transferWalletCopiesToProfileZone(args: {
  assetId: string;
  walletAddress: string;
  profileId: string;
  quantity: number;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<void> {
  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const profileId = normalizeAddr(args.profileId);
  const wallet = normalizeAddr(args.walletAddress);
  if (!profileId) throw new Error('Profile zone id required to move copies for listing.');
  if (!args.deps.signer) throw new Error('Connect Wander to list from your profile zone.');

  args.onStatus?.({
    processing: true,
    success: false,
    message: `Moving ${qty} cop${qty === 1 ? 'y' : 'ies'} to profile zone for UCM listing…`,
  });

  await args.deps.ao.message({
    process: args.assetId,
    signer: args.deps.signer,
    tags: [
      { name: 'Action', value: 'Transfer' },
      { name: 'Recipient', value: profileId },
      { name: 'Quantity', value: String(qty) },
    ],
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    const { profileCopies } = await readAssetHolderBalances({
      assetId: args.assetId,
      walletAddress: wallet,
      profileId,
      deps: args.deps,
    });
    if (profileCopies >= qty) return;
    await sleep(2000);
  }

  throw new Error('Copies were sent to your profile zone but balance is not confirmed yet. Wait and try again.');
}

async function submitProfileZoneUcmOrder(args: {
  deps: ReturnType<typeof buildUcmDeps>;
  profileId: string;
  assetId: string;
  orderbookId: string;
  quantity: string;
  unitPrice: string;
  quoteTokenId: string;
  quoteDenomination: number;
  listingAction: 'Run-Action' | 'Transfer';
}): Promise<string> {
  if (!args.deps.signer) throw new Error('Connect Wander to list from your profile zone.');

  const groupId = Date.now().toString();
  const transferInput = { Recipient: args.orderbookId, Quantity: args.quantity };
  const orderTags = [
    { name: 'Recipient', value: args.orderbookId },
    { name: 'Quantity', value: args.quantity },
    { name: 'X-Order-Action', value: 'Create-Order' },
    { name: 'X-Base-Token', value: args.assetId },
    { name: 'X-Quote-Token', value: args.quoteTokenId },
    { name: 'X-Base-Token-Denomination', value: String(ASSET_DENOMINATION) },
    { name: 'X-Quote-Token-Denomination', value: String(args.quoteDenomination) },
    { name: 'X-Dominant-Token', value: args.assetId },
    { name: 'X-Swap-Token', value: args.quoteTokenId },
    { name: 'X-Group-ID', value: groupId },
    { name: 'X-Price', value: args.unitPrice },
  ];

  if (args.listingAction === 'Transfer') {
    const tags = [
      { name: 'Action', value: 'Transfer' },
      { name: 'Target', value: args.assetId },
      ...orderTags,
    ];
    const raw = await args.deps.ao.message({
      process: args.profileId,
      signer: args.deps.signer,
      tags,
    });
    return normalizeUcmMessageId(raw) || String(raw || '');
  }

  const tags = [
    { name: 'Action', value: 'Run-Action' },
    { name: 'ForwardTo', value: args.assetId },
    { name: 'ForwardAction', value: 'Transfer' },
    { name: 'Forward-To', value: args.assetId },
    { name: 'Forward-Action', value: 'Transfer' },
    ...orderTags,
  ];
  const data = JSON.stringify({ Target: args.assetId, Action: 'Transfer', Input: transferInput });
  const raw = await args.deps.ao.message({
    process: args.profileId,
    signer: args.deps.signer,
    tags,
    data,
  });
  return normalizeUcmMessageId(raw) || String(raw || '');
}

async function waitForWalletAskOnOrderbook(args: {
  orderbookId: string;
  assetId: string;
  askCreatorIds: string[];
  quoteTokenId?: string | null;
  quoteSymbol?: string;
  deps: ReturnType<typeof buildUcmDeps>;
  orderId?: unknown;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<void> {
  args.onStatus?.({
    processing: true,
    success: false,
    message: `Waiting for UCM to confirm on orderbook ${args.orderbookId.slice(0, 8)}…`,
  });

  await hydrateProcessOnPortalAndBazar(args.orderbookId, { waitBetweenMs: 400 }).catch(() => {});
  await hydrateProcessOnPortalAndBazar(args.assetId, { waitBetweenMs: 400 }).catch(() => {});

  const confirmedOrderId = normalizeUcmMessageId(args.orderId) || null;
  const marketLabel = args.quoteSymbol || 'wAR';

  for (let attempt = 0; attempt < 45; attempt++) {
    const info = await readDedicatedOrderbookInfo(args.orderbookId);
    if (
      findSellerAskInOrderbookInfo(info, {
        assetId: args.assetId,
        askCreatorIds: args.askCreatorIds,
        quoteTokenId: args.quoteTokenId,
        orderId: confirmedOrderId,
      })
    ) {
      return;
    }
    if (attempt > 0 && attempt % 5 === 0) {
      await hydrateProcessOnPortalAndBazar(args.orderbookId).catch(() => {});
    }
    await sleep(2000);
  }

  const orderHint = formatUcmOrderHint(args.orderId);
  throw new Error(
    `UCM listing was sent${orderHint} but no sell order appeared on dedicated orderbook ${args.orderbookId.slice(0, 8)} yet. ` +
      `Profile listings are two steps: (1) Run-Action on your profile zone — you sign this; (2) the zone forwards a Transfer on the asset — that message appears on the asset process, not as Run-Action. ` +
      `On Lunar, open the asset (${args.assetId.slice(0, 8)}…) and look for a forwarded Transfer with Recipient=${args.orderbookId.slice(0, 8)}… and a Credit-Notice to the orderbook. ` +
      `"Error getting result" on Lunar is often a compute display issue — check associated/outgoing messages, not only Output. ` +
      `Full orderbook id: ${args.orderbookId}. Wait a few minutes, click Refresh listings, or open the asset on Bazar and select ${marketLabel} as the market token.`
  );
}

/**
 * List copies of a music atomic asset on UCM (limit ask).
 * Seller must hold enough balance on the asset process in the connected wallet.
 */
export async function listMusicAssetOnUcm(args: {
  assetId: string;
  walletAddress: string;
  /** Permaweb profile zone id when asset was profile-minted. */
  profileId?: string | null;
  /** Asset id appears in profile zone `assets[]` (profile-originated listing). */
  profileHasAsset?: boolean;
  /** Legacy ao-profile uses Transfer on zone; Portal zones use Run-Action. */
  isLegacyProfile?: boolean;
  quantity: number;
  /** Price per copy in quote token units (e.g. 0.1 wAR, not L1 AR). */
  priceQuote: string;
  /** @deprecated use priceQuote */
  priceAr?: string;
  /** AO quote token process id (wAR, PI, PIXL, …). Defaults to wAR. */
  quoteTokenId?: string | null;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<UcmListingResult> {
  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Preparing UCM listing — Wander will prompt you to sign shortly…',
  });

  const wallet = getInjectedWallet();
  if (!wallet) throw new Error('Connect Wander to list on UCM.');

  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const priceRaw = String(args.priceQuote ?? args.priceAr ?? '').trim();
  const priceNum = Number(priceRaw);
  const quoteToken = getUcmQuoteToken(args.quoteTokenId) || getDefaultUcmQuoteToken();
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    throw new Error(`Enter a listing price greater than 0 ${quoteToken.symbol}.`);
  }

  const signer = createDataItemSigner(wallet);
  const deps = buildUcmDeps(signer);

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Checking where your copies are held (wallet vs profile zone)…',
  });

  const listingIdentity = await resolveAssetListingIdentity({
    assetId: args.assetId,
    walletAddress: args.walletAddress,
    profileId: args.profileId,
    profileHasAsset: args.profileHasAsset,
    quantity: qty,
    isLegacyProfile: args.isLegacyProfile,
    deps,
  });

  const balance = await waitForConfirmedSellerBalance({
    assetId: args.assetId,
    walletAddress: args.walletAddress,
    profileId: listingIdentity.profileId ?? args.profileId,
    balanceHolderId: listingIdentity.balanceHolderId,
    minCopies: qty,
    onStatus: args.onStatus,
  });
  if (balance.copies < qty) {
    throw new Error(
      `You only hold ${balance.copies} cop${balance.copies === 1 ? 'y' : 'ies'} of this asset.`
    );
  }

  const orderbookId = await resolveAssetOrderbookId({
    assetId: args.assetId,
    deps,
    onStatus: args.onStatus,
  });
  rememberAssetOrderbookId(args.assetId, orderbookId);

  const orderbookPreview = await readDedicatedOrderbookInfo(orderbookId).catch(() => null);
  const activityId = readActivityProcessId(orderbookPreview);
  if (activityId) rememberAssetActivityId(args.assetId, activityId);

  if (orderbookId === UCM_LEGACY_ORDERBOOK_ID) {
    throw new Error(
      'StreamVault atomic assets must list on a dedicated per-asset orderbook, not the legacy global UCM.'
    );
  }

  if (listingIdentity.listingCreatorId && listingIdentity.profileId) {
    const preflight = await assertProfileZoneCanList({
      assetId: args.assetId,
      walletAddress: args.walletAddress,
      profileId: listingIdentity.profileId,
      quantity: qty,
      deps,
    });

    if (preflight.walletToProfileTransferQty > 0) {
      await transferWalletCopiesToProfileZone({
        assetId: args.assetId,
        walletAddress: args.walletAddress,
        profileId: listingIdentity.profileId,
        quantity: preflight.walletToProfileTransferQty,
        deps,
        onStatus: args.onStatus,
      });
    } else {
      args.onStatus?.({
        processing: true,
        success: false,
        message: `Profile zone already holds ${preflight.profileCopies} cop${preflight.profileCopies === 1 ? 'y' : 'ies'} — skipping wallet→profile move.`,
      });
    }
  }

  args.onStatus?.({
    processing: true,
    success: false,
    message: listingIdentity.listingCreatorId
      ? `Submitting sell order via profile zone Run-Action → orderbook ${orderbookId.slice(0, 8)}…`
      : `Submitting sell order to asset orderbook ${orderbookId.slice(0, 8)}…`,
  });

  const unitPrice = tokenDisplayToBaseUnits(priceRaw, quoteToken.denomination);
  let rawOrderId: unknown;
  const orderArgs: Record<string, string> = {
    orderbookId,
    baseToken: args.assetId,
    quoteToken: quoteToken.id,
    baseTokenDenomination: String(ASSET_DENOMINATION),
    quoteTokenDenomination: String(quoteToken.denomination),
    dominantToken: args.assetId,
    swapToken: quoteToken.id,
    quantity: String(qty),
    unitPrice,
  };

  if (listingIdentity.listingCreatorId) {
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Sending Run-Action to profile zone ${listingIdentity.listingCreatorId.slice(0, 8)}… (sign in Wander)`,
    });
    rawOrderId = await submitProfileZoneUcmOrder({
      deps,
      profileId: listingIdentity.listingCreatorId,
      assetId: args.assetId,
      orderbookId,
      quantity: String(qty),
      unitPrice,
      quoteTokenId: quoteToken.id,
      quoteDenomination: quoteToken.denomination,
      listingAction: listingIdentity.listingAction || 'Run-Action',
    });
    args.onStatus?.({
      processing: true,
      success: false,
      message:
        'Profile zone Run-Action sent — asset should receive a forwarded Transfer with Recipient=orderbook (check asset messages on Lunar).',
    });
  } else {
    orderArgs.walletAddress = args.walletAddress;
    rawOrderId = await createOrder(
      deps,
      orderArgs,
      ucmStatusCallback(args.onStatus, 'Transfer submitted to UCM.')
    );
  }

  const orderId = normalizeUcmMessageId(rawOrderId);
  if (!orderId && rawOrderId == null) throw new Error('UCM did not return an order id.');

  await waitForWalletAskOnOrderbook({
    orderbookId,
    assetId: args.assetId,
    askCreatorIds: listingIdentity.askCreatorIds,
    quoteTokenId: quoteToken.id,
    quoteSymbol: quoteToken.symbol,
    deps,
    orderId,
    onStatus: args.onStatus,
  });

  args.onStatus?.({
    processing: false,
    success: true,
    message:
      `Listed on UCM (${quoteToken.symbol} market). On Bazar, open this asset and select ${quoteToken.symbol} as the market token.`,
  });
  return { orderId: orderId || 'submitted', orderbookId };
}

export type SellerAssetBalance = {
  copies: number;
  /** True when HB Balances were empty but holder matches Creator + supply. */
  inferredFromCreator: boolean;
  /** Profile zone id when asset was minted from a permaweb profile (Bazar/Portal pattern). */
  profileId?: string | null;
};

export type AssetListingIdentity = {
  walletAddress: string;
  assetCreator: string;
  profileId: string | null;
  /** Process id that holds minted copies (profile zone or wallet). */
  balanceHolderId: string;
  /** Pass to @permaweb/ucm createOrder when listing via profile zone (Bazar pattern). */
  listingCreatorId?: string;
  /** Profile zone handler: Run-Action (zone) or Transfer (legacy ao-profile). */
  listingAction?: 'Run-Action' | 'Transfer';
  /** Move this many copies wallet → profile before zone Run-Action listing. */
  walletToProfileTransferQty?: number;
  /** Match orderbook ask Creator against any of these ids. */
  askCreatorIds: string[];
};

function normalizeAddr(addr: string | undefined | null): string {
  return String(addr || '').trim();
}

/** @permaweb/ucm createOrder/cancelOrder may return a string id or a message result object. */
export function normalizeUcmMessageId(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (!value || typeof value !== 'object') return '';

  const row = value as Record<string, unknown>;
  for (const key of [
    'id',
    'Id',
    'messageId',
    'MessageId',
    'txId',
    'TxId',
    'orderId',
    'OrderId',
    'transferId',
    'TransferId',
  ]) {
    const candidate = row[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = normalizeUcmMessageId(entry);
      if (nested) return nested;
    }
  }

  return '';
}

function formatUcmOrderHint(orderId: unknown): string {
  const id = normalizeUcmMessageId(orderId);
  return id ? ` (order ${id.slice(0, 8)}…)` : '';
}

function parseBalanceMap(
  balances: unknown,
  walletAddress: string
): number {
  const wallet = normalizeAddr(walletAddress);
  if (!wallet || balances == null) return 0;

  if (Array.isArray(balances)) {
    let total = 0;
    for (const entry of balances) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const addr =
        normalizeAddr(
          (typeof row.address === 'string' && row.address) ||
            (typeof row.Address === 'string' && row.Address) ||
            (typeof row.wallet === 'string' && row.wallet) ||
            (typeof row.Wallet === 'string' && row.Wallet) ||
            null
        ) || null;
      if (!addr || addr !== wallet) continue;
      const qty = Number(row.balance ?? row.Balance ?? row.quantity ?? row.Quantity ?? 0);
      if (Number.isFinite(qty) && qty > 0) total += Math.floor(qty);
    }
    return total;
  }

  if (typeof balances === 'object') {
    const raw = (balances as Record<string, unknown>)[wallet];
    const n = Number(raw ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  return 0;
}

function readTotalSupply(json: Record<string, unknown> | null | undefined): number {
  if (!json) return 0;
  const top = Number(json.TotalSupply ?? json.totalSupply ?? 0);
  if (Number.isFinite(top) && top > 0) return Math.floor(top);
  const meta = json.Metadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    const fromMeta = Number(m.Totalsupply ?? m.TotalSupply ?? m.totalSupply ?? 0);
    if (Number.isFinite(fromMeta) && fromMeta > 0) return Math.floor(fromMeta);
  }
  return 0;
}

/** Read seller balance for an atomic asset from HyperBEAM (whole copies). */
const BALANCE_READ_TIMEOUT_MS = 10_000;

async function dryrunAssetInfo(assetId: string): Promise<Record<string, unknown> | null> {
  try {
    const deps = buildUcmDeps(null);
    const res: any = await deps.ao.dryrun({
      process: assetId,
      tags: [{ name: 'Action', value: 'Info' }],
    });
    return parseInfoData(res?.Messages?.[0]);
  } catch {
    return null;
  }
}

function withBalanceTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), BALANCE_READ_TIMEOUT_MS);
    }),
  ]);
}

export async function fetchSellerAssetBalance(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  balanceHolderId?: string | null;
}): Promise<SellerAssetBalance> {
  const wallet = normalizeAddr(args.walletAddress);
  const profileId = normalizeAddr(args.profileId) || null;
  const holderId = normalizeAddr(args.balanceHolderId) || wallet;

  const readFromJson = (json: Record<string, unknown> | null | undefined): SellerAssetBalance | null => {
    if (!json) return null;
    const fromWallet = parseBalanceMap(json.Balances ?? json.balances, wallet);
    if (fromWallet > 0) {
      return { copies: fromWallet, inferredFromCreator: false, profileId };
    }
    if (holderId !== wallet) {
      const fromHolder = parseBalanceMap(json.Balances ?? json.balances, holderId);
      if (fromHolder > 0) {
        return { copies: fromHolder, inferredFromCreator: false, profileId: profileId || holderId };
      }
    }
    const token = json.Token;
    if (token && typeof token === 'object') {
      const fromToken = parseBalanceMap((token as Record<string, unknown>).Balances, wallet);
      if (fromToken > 0) {
        return { copies: fromToken, inferredFromCreator: false, profileId };
      }
      if (holderId !== wallet) {
        const fromHolderToken = parseBalanceMap((token as Record<string, unknown>).Balances, holderId);
        if (fromHolderToken > 0) {
          return { copies: fromHolderToken, inferredFromCreator: false, profileId: profileId || holderId };
        }
      }
    }
    return null;
  };

  const [hb, dryrunJson] = await Promise.all([
    withBalanceTimeout(fetchHyperbeamAssetState(args.assetId)),
    withBalanceTimeout(dryrunAssetInfo(args.assetId)),
  ]);
  const hbJson = (hb?.json || null) as Record<string, unknown> | null;
  const fromDryrun = readFromJson(dryrunJson);
  if (fromDryrun) return fromDryrun;
  const fromHb = readFromJson(hbJson);
  if (fromHb) return fromHb;

  const metaJson = dryrunJson || hbJson;
  const creator = normalizeAddr(
    typeof metaJson?.Creator === 'string'
      ? metaJson.Creator
      : typeof metaJson?.creator === 'string'
        ? metaJson.creator
        : null
  );
  const totalSupply = readTotalSupply(metaJson);

  // HB often returns Balances: [] before patch sync; creator still holds minted supply.
  if (wallet && creator && wallet === creator && totalSupply > 0) {
    return { copies: totalSupply, inferredFromCreator: true };
  }

  return { copies: 0, inferredFromCreator: false };
}

/** Poll until seller balance is confirmed on-chain (not creator-inferred). */
export async function waitForConfirmedSellerBalance(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  balanceHolderId?: string | null;
  minCopies?: number;
  timeoutMs?: number;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<SellerAssetBalance> {
  const minCopies = Math.max(1, Math.floor(args.minCopies || 1));
  const timeoutMs = args.timeoutMs ?? 45_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const balance = await fetchSellerAssetBalance(args);
    if (!balance.inferredFromCreator && balance.copies >= minCopies) {
      return balance;
    }
    if (balance.inferredFromCreator && balance.copies >= minCopies) {
      args.onStatus?.({
        processing: true,
        success: false,
        message: `Proceeding with ${balance.copies} cop${balance.copies === 1 ? 'y' : 'ies'} (HyperBEAM balance still syncing) — sign in Wander next…`,
      });
      return balance;
    }
    args.onStatus?.({
      processing: true,
      success: false,
      message:
        balance.inferredFromCreator
          ? `Waiting for HyperBEAM to confirm your wallet balance (${balance.copies} cop${balance.copies === 1 ? 'y' : 'ies'} inferred)…`
          : `Waiting for wallet balance (${balance.copies}/${minCopies} confirmed)…`,
    });
    await sleep(3000);
  }

  const last = await fetchSellerAssetBalance(args);
  if (last.copies >= minCopies) {
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Balance not fully synced — proceeding to Wander sign with ${last.copies} cop${last.copies === 1 ? 'y' : 'ies'}…`,
    });
    return last;
  }
  throw new Error(
    'Your asset balance is not confirmed on-chain yet. Wait a few more minutes for HyperBEAM to sync, refresh this page, then try listing again.'
  );
}

/** Cancel an active UCM sell order and return tokens to your wallet. */
export async function cancelUcmListing(args: {
  orderbookId: string;
  orderId: string;
  assetId: string;
  quoteToken?: string;
  walletAddress: string;
  profileId?: string | null;
  profileHasAsset?: boolean;
  isLegacyProfile?: boolean;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<string> {
  const wallet = getInjectedWallet();
  if (!wallet) throw new Error('Connect Wander to cancel a UCM listing.');

  const signer = createDataItemSigner(wallet);
  const deps = buildUcmDeps(signer);
  const quoteToken = args.quoteToken || WAR_TOKEN_ID;

  args.onStatus?.({ processing: true, success: false, message: 'Cancelling UCM listing…' });

  const listingIdentity = await resolveAssetListingIdentity({
    assetId: args.assetId,
    walletAddress: args.walletAddress,
    profileId: args.profileId,
    profileHasAsset: args.profileHasAsset,
    quantity: 1,
    isLegacyProfile: args.isLegacyProfile,
  });

  const cancelArgs: Record<string, string> = {
    orderbookId: args.orderbookId,
    orderId: args.orderId,
    dominantToken: args.assetId,
    swapToken: quoteToken,
    walletAddress: args.walletAddress,
  };
  if (listingIdentity.listingCreatorId) {
    cancelArgs.creatorId = listingIdentity.listingCreatorId;
    cancelArgs.action = listingIdentity.listingAction || 'Run-Action';
  }

  const rawCancelId = await cancelOrder(
    deps,
    cancelArgs,
    ucmStatusCallback(args.onStatus, 'Listing cancelled.')
  );

  const cancelId = normalizeUcmMessageId(rawCancelId);
  if (!cancelId && rawCancelId == null) throw new Error('UCM did not confirm cancellation.');

  args.onStatus?.({
    processing: false,
    success: true,
    message: 'Listing cancelled. Copies returned to your wallet.',
  });
  return cancelId || 'cancelled';
}
