/**
 * Universal Content Marketplace (UCM) listing via @permaweb/ucm.
 * Aligns with Bazar / permaweb/ao-ucm: Transfer to dominant token → UCM orderbook.
 */
import { connect, createDataItemSigner } from '@permaweb/aoconnect';
import { cancelOrder, createOrder, createOrderbook } from '@permaweb/ucm';
import { createResilientAoFetch } from './aoFetch';
import { BAZAR_HB_NODE, resolveAoNode, resolveHbReadNodeUrls, resolveHbWriteNodeUrls } from './aoNode';
import { fetchArweaveL1Graphql } from './arweaveDataGateway';
import { fetchHyperbeamAssetMetadata, fetchHyperbeamAssetState, fetchHyperbeamJson, hyperbeamBalancesHaveHoldings } from './hbNode';
import { resolveHbReadNodeUrlsForProcess, resolvePreferredNodesForProcess } from './hbScheduler';
import { hydrateProcessForListingConfirm, hydrateProcessOnPortalAndBazar } from './hbHydration';
import {
  extractAssetAsksFromInfo,
  findSellerAskInOrderbookInfo,
  isValidAoProcessId,
  readActivityProcessId,
  readDedicatedOrderbookInfo,
} from './ucmOrderbookRead';
import { readOrderbookIdFromAssetJson } from './ucmAssetOrderbook';
import {
  discoverActivityIdForOrderbook,
  discoverDedicatedOrderbookIdFromGraphql,
  discoverUcmProcessesFromGraphql,
} from './ucmOrderbookDiscover';
import {
  getCachedAssetActivityId,
  getCachedAssetOrderbookId,
  markOrderbookHbCompatPatched,
  markOrderbookSpawnedForAsset,
  rememberAssetActivityId,
  rememberAssetOrderbookId,
  wasOrderbookHbCompatPatched,
  wasOrderbookSpawnedForAsset,
} from './ucmOrderbookCache';
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

function ucmDebugEnabled(): boolean {
  if (String(import.meta.env.VITE_DEBUG_UCM || '') === '1') return true;
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('streamvault:debug-ucm') === '1';
  } catch {
    return false;
  }
}

function debugUcm(label: string, data?: Record<string, unknown>): void {
  if (!ucmDebugEnabled()) return;
  try {
    console.info(`[ucm] ${label}`, data || {});
  } catch {
    // ignore console failures
  }
}

export type UcmListingStatus = {
  processing: boolean;
  success: boolean;
  message: string;
};

export type UcmAskConfirmStatus = 'ask-live' | 'escrowed-unread' | 'unconfirmed';

export type UcmListingResult = {
  orderId: string;
  orderbookId: string;
  /** Whether the sell ask is readable on HyperBEAM after Transfer. */
  askStatus: UcmAskConfirmStatus;
};

function getInjectedWallet(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).arweaveWallet || null;
}

const UCM_WALLET_PERMISSIONS = [
  'ACCESS_ADDRESS',
  'ACCESS_PUBLIC_KEY',
  'SIGN_TRANSACTION',
  'SIGNATURE',
  'DISPATCH',
] as const;

async function ensureUcmWalletReady(wallet: any): Promise<void> {
  if (!wallet?.connect) return;
  await wallet.connect([...UCM_WALLET_PERMISSIONS]);
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
  // Dryrun / compute against the fast read node (Bazar). Signed pushes are rewritten by
  // createResilientAoFetch onto Portal-first write URLs — do not pin URL to Portal or
  // every balance dryrun hangs and Wander never opens (VPN user-gesture expiry).
  // preferSyncPush: Create-Order must forward Credit-Notice onto the orderbook schedule;
  // async-first often leaves escrowed copies with Orderbook: [] (Lunar shows CN Success
  // but "Error getting result" because the orderbook never executed the message).
  const readUrl = resolveHbReadNodeUrls()[0] || BAZAR_HB_NODE;
  const config: Record<string, unknown> = {
    MODE: 'mainnet',
    URL: readUrl,
    SCHEDULER: node.scheduler,
    fetch: createResilientAoFetch({
      writeNodeUrls: resolveHbWriteNodeUrls(),
      preferSyncPush: true,
      // Longer attempt so Portal sync push can finish outbox forward before failover.
      pushAttemptTimeoutMs: 20_000,
    }),
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
  /** UI / GraphQL discovered orderbook — skip slow HB metadata probes. */
  orderbookIdHint?: string | null;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<string> {
  const hint = String(args.orderbookIdHint || '').trim();
  if (hint) {
    rememberAssetOrderbookId(args.assetId, hint);
    markOrderbookSpawnedForAsset(args.assetId, hint);
    return hint;
  }

  const cached = getCachedAssetOrderbookId(args.assetId);
  if (cached) return cached;

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Looking up dedicated orderbook for this asset…',
  });

  const hb = await withBalanceTimeout(fetchHyperbeamAssetState(args.assetId));
  let fromMeta = pickOrderbookIdFromHb(hb?.json as Record<string, unknown> | undefined);
  if (fromMeta) {
    rememberAssetOrderbookId(args.assetId, fromMeta);
    return fromMeta;
  }

  // Prefer L1 GraphQL over Portal dryrun — dryrun often hangs when Metadata is empty.
  const fromGraphql = await discoverDedicatedOrderbookIdFromGraphql(args.assetId).catch(() => null);
  if (fromGraphql) return fromGraphql;

  fromMeta = await withBalanceTimeout(readAssetOrderbookIdDryrun(args.assetId, args.deps)).catch(
    () => null
  );
  if (fromMeta) {
    rememberAssetOrderbookId(args.assetId, fromMeta);
    return fromMeta;
  }

  if (wasOrderbookSpawnedForAsset(args.assetId)) {
    // Spawn flag without readable Metadata can happen after Portal HB lag — try GQL once more
    // then proceed only if we still have a cached id from the earlier spawn.
    const retryGraphql = await discoverDedicatedOrderbookIdFromGraphql(args.assetId).catch(() => null);
    if (retryGraphql) return retryGraphql;
    const spawnedCached = getCachedAssetOrderbookId(args.assetId);
    if (spawnedCached) return spawnedCached;
    throw new Error(
      'Dedicated orderbook was already spawned for this asset but Metadata.OrderbookId is not readable yet. ' +
        'Refresh the page — StreamVault caches the orderbook id after listing.'
    );
  }

  args.onStatus?.({
    processing: true,
    success: false,
    message:
      'Open Wander — spawning Orderbook + Activity for this asset (you may sign more than once)…',
  });
  const orderbookId = await createOrderbook(
    args.deps,
    { assetId: args.assetId, writeToAsset: true },
    ucmStatusCallback(args.onStatus, 'Dedicated orderbook ready.')
  );
  if (!orderbookId) throw new Error('UCM orderbook creation returned no id.');
  debugUcm('createOrderbook:created', {
    assetId: args.assetId,
    orderbookId,
    writeToAsset: true,
  });

  rememberAssetOrderbookId(args.assetId, orderbookId);
  markOrderbookSpawnedForAsset(args.assetId, orderbookId);

  // Do not block the sell Transfer on Metadata.OrderbookId sync — listing uses the cached id.
  // Activity discovery can continue in the background while Wander signs the Transfer next.
  args.onStatus?.({
    processing: true,
    success: false,
    message: `Orderbook ${orderbookId.slice(0, 8)}… ready — next: sign Transfer to list…`,
  });
  void cacheActivityAfterOrderbookSpawn(args.assetId, orderbookId, args.deps).catch(() => {});
  void waitForAssetOrderbookLink({
    assetId: args.assetId,
    orderbookId,
    deps: args.deps,
    onStatus: undefined,
  }).catch(() => {});

  return orderbookId;
}

/** After first-list spawn, persist Activity process id (Eval + GraphQL can lag briefly). */
async function cacheActivityAfterOrderbookSpawn(
  assetId: string,
  orderbookId: string,
  deps: ReturnType<typeof buildUcmDeps>
): Promise<void> {
  if (getCachedAssetActivityId(assetId)) return;

  for (let attempt = 0; attempt < 8; attempt++) {
    const info = await readDedicatedOrderbookInfo(orderbookId).catch(() => null);
    const fromInfo = readActivityProcessId(info);
    if (fromInfo) {
      rememberAssetActivityId(assetId, fromInfo);
      notifyMarketplaceUpdated();
      return;
    }

    const discovered = await discoverUcmProcessesFromGraphql(assetId).catch(() => null);
    if (discovered?.activityProcessId) {
      rememberAssetActivityId(assetId, discovered.activityProcessId);
      notifyMarketplaceUpdated();
      return;
    }

    await sleep(1500);
  }

  // Dryrun Info as last resort (ACTIVITY_PROCESS may already be set).
  try {
    const res: any = await deps.ao.dryrun({
      process: orderbookId,
      tags: [{ name: 'Action', value: 'Info' }],
    });
    const json = parseInfoData(res?.Messages?.[0]);
    const fromDry = readActivityProcessId(json);
    if (fromDry) {
      rememberAssetActivityId(assetId, fromDry);
      notifyMarketplaceUpdated();
    }
  } catch {
    // Activity id will appear in UcmMarketProcesses once GraphQL indexes the spawn.
  }
}

async function ensureOrderbookActivityLinked(args: {
  assetId: string;
  orderbookId: string;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<string> {
  const cached = getCachedAssetActivityId(args.assetId);
  if (isValidAoProcessId(cached)) return cached;

  for (let attempt = 0; attempt < 5; attempt++) {
    const info = await readDedicatedOrderbookInfo(args.orderbookId).catch(() => null);
    const fromInfo = readActivityProcessId(info);
    if (fromInfo) {
      rememberAssetActivityId(args.assetId, fromInfo);
      return fromInfo;
    }

    const discovered = await discoverUcmProcessesFromGraphql(args.assetId).catch(() => null);
    if (discovered?.activityProcessId && isValidAoProcessId(discovered.activityProcessId)) {
      rememberAssetActivityId(args.assetId, discovered.activityProcessId);
      return discovered.activityProcessId;
    }

    const paired = await discoverActivityIdForOrderbook(args.orderbookId).catch(() => null);
    if (paired && isValidAoProcessId(paired)) {
      rememberAssetActivityId(args.assetId, paired);
      return paired;
    }

    args.onStatus?.({
      processing: true,
      success: false,
      message: `Waiting for orderbook activity process to index… (${attempt + 1}/5)`,
    });
    await sleep(1800);
  }

  throw new Error(
    'Dedicated orderbook is not linked to a valid activity process yet. ' +
      'Listing is blocked because this orderbook source updates activity before syncing ask state; retry after the activity process indexes.'
  );
}

type StuckCreateOrderNotice = {
  id: string;
  sender: string;
  quantity: string;
  dominant: string;
  swap: string;
  price: string;
  groupId: string;
  timestamp?: string;
};

function luaString(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buildStuckNoticesLuaTable(notices: StuckCreateOrderNotice[]): string {
  if (!notices.length) return '{}';
  const rows = notices.map((n) => {
    const fields = [
      `id=${luaString(n.id)}`,
      `sender=${luaString(n.sender)}`,
      `quantity=${luaString(n.quantity)}`,
      `dominant=${luaString(n.dominant)}`,
      `swap=${luaString(n.swap)}`,
      `price=${luaString(n.price)}`,
      `groupId=${luaString(n.groupId || 'None')}`,
      `timestamp=${luaString(n.timestamp || String(Date.now()))}`,
    ];
    return `{ ${fields.join(', ')} }`;
  });
  return `{ ${rows.join(', ')} }`;
}

/**
 * HB often exposes AO tags in lowercase (`x-order-action`) while UCM handlers read
 * Title-Case (`X-Order-Action`). Credit-Notice then matches but skips Create-Order,
 * leaving escrowed copies and Orderbook/Orders empty. Repair:
 * 1) prepend tag normalizer for future messages
 * 2) replay stuck Create-Order Credit-Notices with Title-Case tags
 * 3) patch with json.encode (raw getState() corrupts Info / "Error getting result")
 */
function buildOrderbookRepairEvalData(args: {
  activityProcessId: string;
  recoverNotices: StuckCreateOrderNotice[];
}): string {
  const noticesLua = buildStuckNoticesLuaTable(args.recoverNotices);
  return (
    `ACTIVITY_PROCESS = ${luaString(args.activityProcessId)}\n` +
    `UCM_STREAMVAULT_HB_PATCH = true\n` +
    `local json = require('json')\n` +
    `local function svRemoveHandler(name)\n` +
    `  pcall(function()\n` +
    `    if Handlers and Handlers.remove then Handlers.remove(name) end\n` +
    `    if Handlers and Handlers.list then\n` +
    `      for i = #Handlers.list, 1, -1 do\n` +
    `        local h = Handlers.list[i]\n` +
    `        if h and (h.name == name or h.name == string.lower(name)) then\n` +
    `          table.remove(Handlers.list, i)\n` +
    `        end\n` +
    `      end\n` +
    `    end\n` +
    `  end)\n` +
    `end\n` +
    `svRemoveHandler('Qualify-Message')\n` +
    `svRemoveHandler('qualify message')\n` +
    `svRemoveHandler('StreamVault-Normalize-Tags')\n` +
    `local SV_TAG_CANON = {\n` +
    `  action = 'Action', sender = 'Sender', quantity = 'Quantity',\n` +
    `  ['x-order-action'] = 'X-Order-Action', ['x-dominant-token'] = 'X-Dominant-Token',\n` +
    `  ['x-swap-token'] = 'X-Swap-Token', ['x-price'] = 'X-Price',\n` +
    `  ['x-group-id'] = 'X-Group-ID',\n` +
    `  ['x-base-token'] = 'X-Base-Token', ['x-quote-token'] = 'X-Quote-Token',\n` +
    `  ['x-base-token-denomination'] = 'X-Base-Token-Denomination',\n` +
    `  ['x-quote-token-denomination'] = 'X-Quote-Token-Denomination',\n` +
    `  ['x-transfer-denomination'] = 'X-Transfer-Denomination',\n` +
    `}\n` +
    `local function svNormalizeTags(msg)\n` +
    `  if type(msg) ~= 'table' then return msg end\n` +
    `  msg.Tags = msg.Tags or {}\n` +
    `  local tags = msg.Tags\n` +
    `  local added = {}\n` +
    `  for k, v in pairs(tags) do\n` +
    `    if type(k) == 'string' then\n` +
    `      local canon = SV_TAG_CANON[string.lower(k)]\n` +
    `      if canon and tags[canon] == nil then added[canon] = v end\n` +
    `    end\n` +
    `  end\n` +
    `  for k, v in pairs(added) do tags[k] = v end\n` +
    `  if tags['X-Group-ID'] == nil and tags['X-Group-Id'] ~= nil then tags['X-Group-ID'] = tags['X-Group-Id'] end\n` +
    `  if tags.Action and msg.Action == nil then msg.Action = tags.Action end\n` +
    `  return msg\n` +
    `end\n` +
    `Handlers.prepend('StreamVault-Normalize-Tags', function() return true end, function(msg)\n` +
    `  svNormalizeTags(msg)\n` +
    `end)\n` +
    `local function svOrderExists(id)\n` +
    `  if not id or type(Orderbook) ~= 'table' then return false end\n` +
    `  for _, pair in ipairs(Orderbook) do\n` +
    `    for _, key in ipairs({ 'Asks', 'Bids', 'Orders', 'asks', 'bids', 'orders' }) do\n` +
    `      for _, order in ipairs(pair[key] or {}) do\n` +
    `        if order.Id == id or order.id == id then return true end\n` +
    `      end\n` +
    `    end\n` +
    `  end\n` +
    `  return false\n` +
    `end\n` +
    `local function svReplayNotice(n)\n` +
    `  if type(n) ~= 'table' or not n.id or svOrderExists(n.id) then return false end\n` +
    `  local msg = {\n` +
    `    Id = n.id, From = n.dominant, Owner = Owner or ao.id,\n` +
    `    Timestamp = n.timestamp, ['Block-Height'] = '0',\n` +
    `    Action = 'Credit-Notice',\n` +
    `    Tags = {\n` +
    `      Action = 'Credit-Notice', Sender = n.sender, Quantity = n.quantity,\n` +
    `      ['X-Order-Action'] = 'Create-Order', ['X-Dominant-Token'] = n.dominant,\n` +
    `      ['X-Swap-Token'] = n.swap, ['X-Price'] = n.price,\n` +
    `      ['X-Group-ID'] = n.groupId or 'None', ['X-Base-Token'] = n.dominant,\n` +
    `      ['X-Quote-Token'] = n.swap,\n` +
    `    }\n` +
    `  }\n` +
    `  svNormalizeTags(msg)\n` +
    `  local ok = pcall(function() Handlers.evaluate(msg, ao) end)\n` +
    `  return ok\n` +
    `end\n` +
    `local streamvaultReplayed = 0\n` +
    `local recover = ${noticesLua}\n` +
    `for _, n in ipairs(recover) do\n` +
    `  if svReplayNotice(n) then streamvaultReplayed = streamvaultReplayed + 1 end\n` +
    `end\n` +
    `pcall(function()\n` +
    `  if type(Inbox) == 'table' then\n` +
    `    for _, pending in ipairs(Inbox) do\n` +
    `      svNormalizeTags(pending)\n` +
    `      local tags = pending.Tags or {}\n` +
    `      local action = pending.Action or tags.Action\n` +
    `      local orderAction = tags['X-Order-Action']\n` +
    `      local dominant = tags['X-Dominant-Token']\n` +
    `      local id = pending.Id or pending.id\n` +
    `      if action == 'Credit-Notice' and orderAction == 'Create-Order' and dominant == pending.From and not svOrderExists(id) then\n` +
    `        if pcall(function() Handlers.evaluate(pending, ao) end) then\n` +
    `          streamvaultReplayed = streamvaultReplayed + 1\n` +
    `        end\n` +
    `      end\n` +
    `    end\n` +
    `  end\n` +
    `end)\n` +
    `UCM_STREAMVAULT_REPLAYED = streamvaultReplayed\n` +
    `local function svState()\n` +
    `  return { Name = Name, Orderbook = Orderbook, ActivityProcess = ACTIVITY_PROCESS }\n` +
    `end\n` +
    `pcall(function()\n` +
    `  Send({ device = 'patch@1.0', orderbook = json.encode(svState()) })\n` +
    `end)\n` +
    `print(json.encode({\n` +
    `  ok = true,\n` +
    `  activity = ACTIVITY_PROCESS,\n` +
    `  replayed = streamvaultReplayed,\n` +
    `  pairs = type(Orderbook) == 'table' and #Orderbook or -1,\n` +
    `}))\n`
  );
}

async function discoverStuckCreateOrderNotices(args: {
  orderbookId: string;
  assetId: string;
}): Promise<StuckCreateOrderNotice[]> {
  const orderbookId = normalizeAddr(args.orderbookId);
  const assetId = normalizeAddr(args.assetId);
  if (!orderbookId || !assetId) return [];

  const gqlUrl =
    (import.meta.env.VITE_AO_GQL_URL as string | undefined)?.trim() ||
    'https://ao-search-gateway.goldsky.com/graphql';

  // AO Goldsky often indexes tag names lowercased — fetch by recipient and filter client-side.
  const query = `query($recipients: [String!]!) {
    transactions(recipients: $recipients, first: 15, sort: HEIGHT_DESC) {
      edges {
        node {
          id
          block { timestamp }
          tags { name value }
        }
      }
    }
  }`;

  try {
    const res = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query,
        variables: { recipients: [orderbookId] },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: {
        transactions?: {
          edges?: Array<{
            node?: {
              id?: string;
              block?: { timestamp?: number };
              tags?: Array<{ name?: string; value?: string }>;
            };
          }>;
        };
      };
    };
    const edges = json?.data?.transactions?.edges || [];
    const out: StuckCreateOrderNotice[] = [];
    for (const edge of edges) {
      const node = edge?.node;
      const id = String(node?.id || '').trim();
      if (!isValidAoProcessId(id)) continue;
      const tags: Record<string, string> = {};
      for (const t of node?.tags || []) {
        const name = String(t?.name || '').trim();
        const value = String(t?.value || '').trim();
        if (!name) continue;
        tags[name] = value;
        tags[name.toLowerCase()] = value;
      }
      const orderAction = tags['X-Order-Action'] || tags['x-order-action'] || '';
      if (orderAction !== 'Create-Order') continue;
      const sender = tags.Sender || tags.sender || '';
      const quantity = tags.Quantity || tags.quantity || '';
      const dominant =
        tags['X-Dominant-Token'] ||
        tags['x-dominant-token'] ||
        tags['X-Base-Token'] ||
        tags['x-base-token'] ||
        assetId;
      if (dominant !== assetId) continue;
      const swap =
        tags['X-Swap-Token'] ||
        tags['x-swap-token'] ||
        tags['X-Quote-Token'] ||
        tags['x-quote-token'] ||
        WAR_TOKEN_ID;
      const price = tags['X-Price'] || tags['x-price'] || '';
      const groupId = tags['X-Group-ID'] || tags['X-Group-Id'] || tags['x-group-id'] || 'None';
      if (!sender || !quantity || !price) continue;
      out.push({
        id,
        sender,
        quantity,
        dominant,
        swap,
        price,
        groupId,
        timestamp: node?.block?.timestamp ? String(node.block.timestamp * 1000) : String(Date.now()),
      });
    }
    debugUcm('orderbook:stuck-cn-discovered', {
      orderbookId,
      assetId,
      count: out.length,
      ids: out.map((n) => n.id),
    });
    return out;
  } catch {
    return [];
  }
}

async function repairOrderbookActivityLink(args: {
  assetId: string;
  orderbookId: string;
  activityProcessId: string;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
  /** When set, skip GQL discovery (e.g. just-submitted listing). */
  recoverNotices?: StuckCreateOrderNotice[];
}): Promise<string> {
  if (!args.deps.signer) return '';

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Open Wander — repairing orderbook handlers / replaying escrowed Create-Order…',
  });

  const recoverNotices =
    args.recoverNotices ||
    (await discoverStuckCreateOrderNotices({
      orderbookId: args.orderbookId,
      assetId: args.assetId,
    }).catch(() => []));

  const evalData = buildOrderbookRepairEvalData({
    activityProcessId: args.activityProcessId,
    recoverNotices,
  });
  debugUcm('orderbook:repair-eval', {
    assetId: args.assetId,
    orderbookId: args.orderbookId,
    activityProcessId: args.activityProcessId,
    recoverCount: recoverNotices.length,
    recoverIds: recoverNotices.map((n) => n.id),
    tags: [
      { name: 'Action', value: 'Eval' },
      { name: 'Message-Timestamp', value: '<generated at send>' },
    ],
    data: evalData,
  });
  const messageId = await withWanderSignTimeout(
    args.deps.ao.message({
      process: args.orderbookId,
      signer: args.deps.signer,
      tags: [
        { name: 'Action', value: 'Eval' },
        { name: 'Message-Timestamp', value: Date.now().toString() },
      ],
      data: evalData,
    }),
    'Orderbook activity link'
  );

  await hydrateProcessOnPortalAndBazar(args.orderbookId, {
    waitBetweenMs: 0,
    timeoutMs: 8_000,
    retries: 1,
    includeOperator: true,
    operatorBackground: true,
  }).catch(() => {});

  return String(messageId || '');
}

async function ensureOrderbookReadyForCreateOrder(args: {
  assetId: string;
  orderbookId: string;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<void> {
  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Verifying orderbook activity link before listing…',
  });

  const activityProcessId = await ensureOrderbookActivityLinked(args);
  debugUcm('orderbook:activity-discovered', {
    assetId: args.assetId,
    orderbookId: args.orderbookId,
    activityProcessId,
  });
  let info = await readDedicatedOrderbookInfo(args.orderbookId).catch(() => null);
  let linked = readActivityProcessId(info);
  if (linked === activityProcessId && wasOrderbookHbCompatPatched(args.orderbookId)) return;

  const repairMessageId = await repairOrderbookActivityLink({ ...args, activityProcessId });

  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(1500);
    info = await readDedicatedOrderbookInfo(args.orderbookId).catch(() => null);
    linked = readActivityProcessId(info);
    if (linked === activityProcessId) {
      rememberAssetActivityId(args.assetId, activityProcessId);
      markOrderbookHbCompatPatched(args.orderbookId);
      return;
    }
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Waiting for orderbook activity link to hydrate… (${attempt + 1}/5)`,
    });
  }

  throw new Error(
    `Orderbook ${args.orderbookId.slice(0, 8)}… activity link is not readable yet. ` +
      `Repair message ${repairMessageId || 'submitted'} was accepted, but HyperBEAM did not expose the link yet. ` +
      'StreamVault will not escrow more copies until the ask can sync.'
  );
}

function notifyMarketplaceUpdated(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event('streamvault:marketplace-updated'));
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wander sign prompts have no built-in timeout — without this, listing stalls forever on "Open Wander…". */
const WANDER_SIGN_TIMEOUT_MS = 120_000;

async function withWanderSignTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} timed out waiting for Wander. Unlock the extension and approve the popup. ` +
                `If no popup appears, briefly disable VPN (extension popups often break under VPN), then try List again.`
            )
          );
        }, WANDER_SIGN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isWanderSignFailure(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || '');
  return /timed out waiting for Wander|user (rejected|denied|cancelled|canceled)|request rejected|sign.*cancelled|sign.*canceled/i.test(
    msg
  );
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

  for (let attempt = 0; attempt < 8; attempt++) {
    const hb = await withBalanceTimeout(fetchHyperbeamAssetState(args.assetId));
    const fromHb = pickOrderbookIdFromHb(hb?.json as Record<string, unknown> | undefined);
    if (fromHb === args.orderbookId) return;

    const fromDryrun = await withBalanceTimeout(
      readAssetOrderbookIdDryrun(args.assetId, args.deps)
    ).catch(() => null);
    if (fromDryrun === args.orderbookId) return;

    await sleep(1500);
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
    walletCopies = Math.max(
      walletCopies,
      (await withBalanceTimeout(readHolderBalanceViaDryrun(args.assetId, wallet, deps))) ?? 0
    );
  }
  if (profileId) {
    profileCopies = Math.max(
      profileCopies,
      (await withBalanceTimeout(readHolderBalanceViaDryrun(args.assetId, profileId, deps))) ?? 0
    );
  }

  const creator = readCreatorFromJson(hbJson) || readCreatorFromJson(dryrunJson) || wallet;
  const totalSupply = await resolveAssetTotalSupply(args.assetId, hbJson, dryrunJson);

  return { walletCopies, profileCopies, creator, totalSupply };
}

export async function resolveAssetListingIdentity(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  profileHasAsset?: boolean;
  quantity?: number;
  isLegacyProfile?: boolean;
  /** Balance from waitForConfirmedSellerBalance — avoids re-routing when HB maps are empty. */
  confirmedSeller?: SellerAssetBalance | null;
  creatorHint?: string | null;
  deps?: ReturnType<typeof buildUcmDeps>;
}): Promise<AssetListingIdentity> {
  const wallet = normalizeAddr(args.walletAddress);
  const profileId = normalizeAddr(args.profileId) || null;
  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const isLegacyProfile = Boolean(args.isLegacyProfile);
  const confirmed = args.confirmedSeller;
  const creatorHint = normalizeAddr(args.creatorHint) || null;

  // Fast path: creator-wallet first list — skip Portal Balances re-probes so Wander opens next.
  // profileHasAsset alone must not force the zone path (that was the empty-Balances hang).
  if (
    confirmed &&
    confirmed.copies >= qty &&
    (confirmed.inferredFromCreator || (creatorHint != null && creatorHint === wallet))
  ) {
    const creator = creatorHint || wallet;
    return {
      walletAddress: wallet,
      assetCreator: creator,
      profileId,
      balanceHolderId: wallet,
      askCreatorIds: uniqueAddrs([wallet, creator, profileId]),
    };
  }

  const { walletCopies, profileCopies, creator: creatorFromState } = await readAssetHolderBalances({
    assetId: args.assetId,
    walletAddress: wallet,
    profileId,
    deps: args.deps,
  });
  const creator = creatorFromState || creatorHint || wallet;

  const inferredWalletCopies =
    confirmed?.inferredFromCreator && confirmed.copies >= qty ? confirmed.copies : 0;
  const effectiveWalletCopies = Math.max(walletCopies, inferredWalletCopies);
  const effectiveProfileCopies = profileCopies;

  const askCreatorIds = uniqueAddrs([wallet, creator, profileId]);
  const profileListingAction = isLegacyProfile ? 'Transfer' : 'Run-Action';
  // Profile-zone mint only when the process Creator is the zone itself — not merely because
  // the asset appears in profile `assets[]` (StreamVault creators usually hold copies in wallet).
  const profileOriginated = Boolean(profileId && creator === profileId);

  // Self-minted assets: always prefer wallet-direct when the connected wallet is the asset creator.
  // HB Balances are often empty/+linked after mint; inferred creator supply is enough to list.
  if (creator === wallet && (effectiveWalletCopies >= qty || inferredWalletCopies >= qty || confirmed?.inferredFromCreator)) {
    return {
      walletAddress: wallet,
      assetCreator: creator || wallet,
      profileId,
      balanceHolderId: wallet,
      askCreatorIds,
    };
  }

  if (effectiveWalletCopies >= qty && creator === wallet) {
    return {
      walletAddress: wallet,
      assetCreator: creator || wallet,
      profileId,
      balanceHolderId: wallet,
      askCreatorIds,
    };
  }

  if (profileId && (profileOriginated || effectiveProfileCopies >= qty)) {
    const walletToProfileTransferQty =
      profileOriginated || effectiveProfileCopies >= qty
        ? 0
        : effectiveWalletCopies > 0
          ? Math.min(effectiveWalletCopies, Math.max(0, qty - effectiveProfileCopies))
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

  if (effectiveWalletCopies >= qty) {
    return {
      walletAddress: wallet,
      assetCreator: creator || wallet,
      profileId,
      balanceHolderId: wallet,
      askCreatorIds,
    };
  }

  if (profileId) {
    // Last resort: only route through the profile zone when it actually holds copies (or is Creator).
    if (effectiveProfileCopies < qty && !profileOriginated) {
      return {
        walletAddress: wallet,
        assetCreator: creator || wallet,
        profileId,
        balanceHolderId: wallet,
        askCreatorIds,
      };
    }
    const walletToProfileTransferQty =
      effectiveWalletCopies > 0
        ? Math.min(effectiveWalletCopies, Math.max(0, qty - effectiveProfileCopies))
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
  confirmedSeller?: SellerAssetBalance | null;
}): Promise<{ walletCopies: number; profileCopies: number; walletToProfileTransferQty: number }> {
  const { walletCopies, profileCopies } = await readAssetHolderBalances({
    assetId: args.assetId,
    walletAddress: args.walletAddress,
    profileId: args.profileId,
    deps: args.deps,
  });
  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const confirmed = args.confirmedSeller;
  const inferredWallet =
    confirmed?.inferredFromCreator && confirmed.copies >= qty ? confirmed.copies : 0;
  const effectiveWallet = Math.max(walletCopies, inferredWallet);
  const effectiveProfile = profileCopies;
  const walletToProfileTransferQty =
    effectiveProfile >= qty ? 0 : Math.max(0, Math.min(effectiveWallet, qty - effectiveProfile));
  if (effectiveProfile + effectiveWallet < qty) {
    throw new Error(
      `Profile zone holds ${effectiveProfile} and wallet holds ${effectiveWallet} — need ${qty} to list.`
    );
  }
  return { walletCopies: effectiveWallet, profileCopies: effectiveProfile, walletToProfileTransferQty };
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
    message: `Open Wander — moving ${qty} cop${qty === 1 ? 'y' : 'ies'} to your profile zone…`,
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

  for (let attempt = 0; attempt < 8; attempt++) {
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
  debugUcm('createOrder:profile-run-action', {
    profileId: args.profileId,
    assetId: args.assetId,
    orderbookId: args.orderbookId,
    transferInput,
    tags,
    data,
  });
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
  walletAddress: string;
  profileId?: string | null;
  deps: ReturnType<typeof buildUcmDeps>;
  orderId?: unknown;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<UcmAskConfirmStatus> {
  const maxAttempts = 10;
  args.onStatus?.({
    processing: true,
    success: false,
    message: `Confirming ask on orderbook ${args.orderbookId.slice(0, 8)}… (warming HyperBEAM)`,
  });

  // Bazar+Portal blocking; operator hydrate in background (do not wait on nyc 500s).
  await Promise.all([
    hydrateProcessForListingConfirm(args.orderbookId).catch(() => {}),
    hydrateProcessForListingConfirm(args.assetId).catch(() => {}),
  ]);

  const confirmedOrderId = normalizeUcmMessageId(args.orderId) || null;
  const marketLabel = args.quoteSymbol || 'wAR';

  const checkEscrowed = async (): Promise<boolean> => {
    const postBalance = await fetchSellerAssetBalance({
      assetId: args.assetId,
      walletAddress: args.walletAddress,
      profileId: args.profileId,
    }).catch(() => null);
    return (postBalance?.escrowedCopies || 0) > 0;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Waiting for UCM to confirm on orderbook ${args.orderbookId.slice(0, 8)}… (${attempt + 1}/${maxAttempts})`,
    });

    const info = await readDedicatedOrderbookInfo(args.orderbookId);
    const askFound = findSellerAskInOrderbookInfo(info, {
        assetId: args.assetId,
        askCreatorIds: args.askCreatorIds,
        quoteTokenId: args.quoteTokenId,
        orderId: confirmedOrderId,
      });
    debugUcm('createOrder:confirm-read', {
      attempt: attempt + 1,
      orderbookId: args.orderbookId,
      assetId: args.assetId,
      quoteTokenId: args.quoteTokenId || null,
      orderId: confirmedOrderId,
      askCreatorIds: args.askCreatorIds,
      askFound,
      hasInfo: Boolean(info),
    });
    if (askFound) {
      return 'ask-live';
    }

    // Transfer succeeded if copies left the wallet into orderbook escrow — stop spinning on ask Info lag.
    if (attempt >= 1 && (await checkEscrowed())) {
      args.onStatus?.({
        processing: false,
        success: false,
        message:
          `Copies are escrowed in orderbook ${args.orderbookId.slice(0, 8)}…, but no ask is readable yet. ` +
          `Lunar may show Credit-Notice Success with "Error getting result" when the orderbook never executed it. ` +
          `Use Refresh listings, or check Bazar with ${marketLabel}.`,
      });
      return 'escrowed-unread';
    }

    if (attempt > 0 && attempt % 3 === 0) {
      void hydrateProcessForListingConfirm(args.orderbookId).catch(() => {});
    }
    await sleep(1500);
  }

  if (await checkEscrowed()) {
    args.onStatus?.({
      processing: false,
      success: false,
      message:
        `Copies are escrowed in orderbook ${args.orderbookId.slice(0, 8)}…, but no ask is readable yet. ` +
        `Lunar may show Credit-Notice Success with "Error getting result" when the orderbook never executed it. ` +
        `Use Refresh listings, or check Bazar with ${marketLabel}.`,
    });
    return 'escrowed-unread';
  }

  args.onStatus?.({
    processing: false,
    success: false,
    message:
      `Sell Transfer was submitted to orderbook ${args.orderbookId.slice(0, 8)}…, but UCM did not confirm an ask. ` +
      `Refresh listings or open the asset on Bazar with ${marketLabel}.`,
  });
  return 'unconfirmed';
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
  /** Known dedicated orderbook from UI cache / GraphQL. */
  orderbookIdHint?: string | null;
  /** L1 / UI creator when HB Creator is missing. */
  creatorHint?: string | null;
  /**
   * UI already confirmed Balances: [] / inferred creator copies —
   * skip slow Portal dryrun loops so Wander opens within the click gesture.
   */
  balancesEmptyConfirmed?: boolean;
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

  // Warm extension permissions immediately while the List click gesture is still active.
  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Connecting Wander permissions…',
  });
  await ensureUcmWalletReady(wallet);

  const qty = Math.max(1, Math.floor(args.quantity || 1));
  const priceRaw = String(args.priceQuote ?? args.priceAr ?? '').trim();
  const priceNum = Number(priceRaw);
  const quoteToken = getUcmQuoteToken(args.quoteTokenId) || getDefaultUcmQuoteToken();
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    throw new Error(`Enter a listing price greater than 0 ${quoteToken.symbol}.`);
  }

  const signer = createDataItemSigner(wallet);
  const deps = buildUcmDeps(signer);

  const creatorHint = normalizeAddr(args.creatorHint);
  const walletAddr = normalizeAddr(args.walletAddress);
  const fastInitPath =
    Boolean(args.balancesEmptyConfirmed) ||
    Boolean(creatorHint && walletAddr && creatorHint === walletAddr);

  let balance: SellerAssetBalance;
  if (fastInitPath && args.balancesEmptyConfirmed) {
    args.onStatus?.({
      processing: true,
      success: false,
      message: 'Creator Balances empty — opening Wander for Init/Mint (no Portal wait)…',
    });
    balance = {
      copies: qty,
      inferredFromCreator: true,
      balancesEmptyConfirmed: true,
      profileId: args.profileId || null,
    };
  } else {
    args.onStatus?.({
      processing: true,
      success: false,
      message: 'Checking where your copies are held (wallet vs profile zone)…',
    });
    balance = await waitForConfirmedSellerBalance({
      assetId: args.assetId,
      walletAddress: args.walletAddress,
      profileId: args.profileId,
      creatorHint: args.creatorHint,
      minCopies: qty,
      onStatus: args.onStatus,
    });
  }
  if (balance.copies < qty) {
    throw new Error(
      `You only hold ${balance.copies} cop${balance.copies === 1 ? 'y' : 'ies'} of this asset.`
    );
  }

  // HyperBEAM often shows Balances: [] for StreamVault assets until Owner sends Init/Mint.
  // Hard gate: never Transfer while balance is still inferred/uncredited.
  if (balance.inferredFromCreator) {
    balance = await ensureCreatorAssetBalance({
      assetId: args.assetId,
      walletAddress: args.walletAddress,
      profileId: args.profileId,
      creatorHint: args.creatorHint,
      deps,
      onStatus: args.onStatus,
      skipPreflightReads: true,
      inferredCopies: balance.copies,
    });
    if (balance.inferredFromCreator || balance.copies < qty) {
      throw new Error(
        `Init/Mint did not credit Balances on this asset (wallet still shows ${balance.copies} inferred / uncredited). ` +
          `Listing Transfer is blocked until HyperBEAM confirms your wallet holds enough copies.`
      );
    }
  }

  const listingIdentity = await resolveAssetListingIdentity({
    assetId: args.assetId,
    walletAddress: args.walletAddress,
    profileId: args.profileId,
    profileHasAsset: args.profileHasAsset,
    quantity: qty,
    isLegacyProfile: args.isLegacyProfile,
    confirmedSeller: balance,
    creatorHint: args.creatorHint,
    deps,
  });

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Resolving dedicated orderbook…',
  });
  const orderbookId = await resolveAssetOrderbookId({
    assetId: args.assetId,
    deps,
    orderbookIdHint: args.orderbookIdHint,
    onStatus: args.onStatus,
  });
  rememberAssetOrderbookId(args.assetId, orderbookId);

  // Activity id discovery must not block Wander Transfer (Info/GQL lag after spawn).
  if (!getCachedAssetActivityId(args.assetId)) {
    void cacheActivityAfterOrderbookSpawn(args.assetId, orderbookId, deps).catch(() => {});
  }

  if (orderbookId === UCM_LEGACY_ORDERBOOK_ID) {
    throw new Error(
      'StreamVault atomic assets must list on a dedicated per-asset orderbook, not the legacy global UCM.'
    );
  }

  await ensureOrderbookReadyForCreateOrder({
    assetId: args.assetId,
    orderbookId,
    deps,
    onStatus: args.onStatus,
  });

  if (listingIdentity.listingCreatorId && listingIdentity.profileId) {
    const preflight = await assertProfileZoneCanList({
      assetId: args.assetId,
      walletAddress: args.walletAddress,
      profileId: listingIdentity.profileId,
      quantity: qty,
      deps,
      confirmedSeller: balance,
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
  debugUcm('createOrder:prepared', {
    mode: listingIdentity.listingCreatorId ? 'profile-zone' : 'wallet-direct',
    assetId: args.assetId,
    orderbookId,
    walletAddress: args.walletAddress,
    profileId: args.profileId || null,
    listingCreatorId: listingIdentity.listingCreatorId || null,
    askCreatorIds: listingIdentity.askCreatorIds,
    quoteTokenId: quoteToken.id,
    quoteSymbol: quoteToken.symbol,
    quantity: String(qty),
    unitPrice,
    expectedTransferTags: [
      { name: 'Recipient', value: orderbookId },
      { name: 'Quantity', value: String(qty) },
      { name: 'X-Order-Action', value: 'Create-Order' },
      { name: 'X-Base-Token', value: args.assetId },
      { name: 'X-Quote-Token', value: quoteToken.id },
      { name: 'X-Base-Token-Denomination', value: String(ASSET_DENOMINATION) },
      { name: 'X-Quote-Token-Denomination', value: String(quoteToken.denomination) },
      { name: 'X-Dominant-Token', value: args.assetId },
      { name: 'X-Swap-Token', value: quoteToken.id },
      { name: 'X-Group-ID', value: '<generated by @permaweb/ucm>' },
      { name: 'X-Price', value: unitPrice },
    ],
  });

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
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Open Wander — signing Transfer to orderbook ${orderbookId.slice(0, 8)}…`,
    });
    orderArgs.walletAddress = args.walletAddress;
    rawOrderId = await createOrder(
      deps,
      orderArgs,
      ucmStatusCallback(args.onStatus, 'Transfer submitted to UCM.')
    );
  }

  const orderId = normalizeUcmMessageId(rawOrderId);
  if (!orderId && rawOrderId == null) throw new Error('UCM did not return an order id.');
  // HyperBEAM often returns the process slot number (e.g. "8") instead of a 43-char message id.
  const transferRef =
    /^\d+$/.test(orderId)
      ? `asset slot ${orderId} (HB push ack — check Bazar / Lunar for the Create-Order Transfer)`
      : orderId;

  let askStatus = await waitForWalletAskOnOrderbook({
    orderbookId,
    assetId: args.assetId,
    askCreatorIds: listingIdentity.askCreatorIds,
    quoteTokenId: quoteToken.id,
    quoteSymbol: quoteToken.symbol,
    walletAddress: args.walletAddress,
    profileId: args.profileId,
    deps,
    orderId,
    onStatus: args.onStatus,
  });

  // Escrowed-unread: HB often lowercases CN tags so UCM skips Create-Order. One owner Eval
  // can normalize tags + replay stuck Credit-Notices onto Orders/Asks.
  if (askStatus === 'escrowed-unread' && deps.signer) {
    args.onStatus?.({
      processing: true,
      success: false,
      message:
        'Copies are escrowed but ask is unread — signing a one-time orderbook repair (tag normalize + Create-Order replay)…',
    });
    try {
      const activityProcessId = await ensureOrderbookActivityLinked({
        assetId: args.assetId,
        orderbookId,
        deps,
        onStatus: args.onStatus,
      }).catch(() => getCachedAssetActivityId(args.assetId));
      if (activityProcessId && isValidAoProcessId(activityProcessId)) {
        await repairOrderbookActivityLink({
          assetId: args.assetId,
          orderbookId,
          activityProcessId,
          deps,
          onStatus: args.onStatus,
        });
        askStatus = await waitForWalletAskOnOrderbook({
          orderbookId,
          assetId: args.assetId,
          askCreatorIds: listingIdentity.askCreatorIds,
          quoteTokenId: quoteToken.id,
          quoteSymbol: quoteToken.symbol,
          walletAddress: args.walletAddress,
          profileId: args.profileId,
          deps,
          orderId,
          onStatus: args.onStatus,
        });
      }
    } catch (repairErr) {
      debugUcm('createOrder:auto-repair-failed', {
        orderbookId,
        error: String((repairErr as { message?: string })?.message || repairErr),
      });
    }
  }

  if (askStatus === 'ask-live') {
    args.onStatus?.({
      processing: false,
      success: true,
      message:
        `Ask live on UCM (${quoteToken.symbol} market; ${transferRef}). On Bazar, open this asset and select ${quoteToken.symbol} as the market token.`,
    });
  } else if (askStatus === 'escrowed-unread') {
    args.onStatus?.({
      processing: false,
      success: false,
      message:
        `Copies escrowed to orderbook ${orderbookId.slice(0, 8)}…, but the ask is not on the orderbook yet (${transferRef}). ` +
        `Asset Credit-Notice can show Success on Lunar while Create-Order never ran (often lowercase HB tags). ` +
        `Use Repair orderbook link, then Refresh — or list a fresh copy after reload.`,
    });
  } else {
    args.onStatus?.({
      processing: false,
      success: false,
      message:
        `Transfer submitted (${transferRef}) but UCM ask was not confirmed. ` +
        `Refresh listings or check Bazar with ${quoteToken.symbol}.`,
    });
  }
  return { orderId: orderId || 'submitted', orderbookId, askStatus };
}

export async function repairUcmOrderbookForAsset(args: {
  assetId: string;
  orderbookId: string;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<{ orderbookId: string; activityProcessId: string }> {
  const orderbookId = normalizeAddr(args.orderbookId);
  if (!orderbookId) throw new Error('Orderbook id required.');

  const wallet = getInjectedWallet();
  if (!wallet) throw new Error('Connect Wander to repair this UCM orderbook.');

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Connecting Wander permissions…',
  });
  await ensureUcmWalletReady(wallet);

  const signer = createDataItemSigner(wallet);
  const deps = buildUcmDeps(signer);
  const activityProcessId = await ensureOrderbookActivityLinked({
    assetId: args.assetId,
    orderbookId,
    deps,
    onStatus: args.onStatus,
  });

  const repairMessageId = await repairOrderbookActivityLink({
    assetId: args.assetId,
    orderbookId,
    activityProcessId,
    deps,
    onStatus: args.onStatus,
  });

  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(1500);
    const info = await readDedicatedOrderbookInfo(orderbookId).catch(() => null);
    const linked = readActivityProcessId(info);
    const asks = info ? extractAssetAsksFromInfo(info, args.assetId, orderbookId) : [];
    if (linked === activityProcessId || asks.length > 0) {
      rememberAssetActivityId(args.assetId, activityProcessId);
      markOrderbookHbCompatPatched(orderbookId);
      args.onStatus?.({
        processing: false,
        success: true,
        message:
          asks.length > 0
            ? `Orderbook repaired — ${asks.length} ask(s) readable. Refresh listings.`
            : 'Orderbook activity link verified. Refresh listings before taking any next action.',
      });
      notifyMarketplaceUpdated();
      return { orderbookId, activityProcessId };
    }
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Repair submitted; waiting for readable orderbook state… (${attempt + 1}/8)`,
    });
  }

  args.onStatus?.({
    processing: false,
    success: false,
    message:
      `Repair message ${repairMessageId || 'submitted'} was accepted, but Info still has no activity/asks. ` +
      'Do not list again while Wallet is 0 — Refresh, then retry Repair once.',
  });
  notifyMarketplaceUpdated();
  return { orderbookId, activityProcessId };
}

export type SellerAssetBalance = {
  copies: number;
  /** Copies keyed directly to the connected wallet in the asset Balances map. */
  walletCopies?: number;
  /** Copies keyed to the seller's profile zone in the asset Balances map. */
  profileCopies?: number;
  /**
   * True when HyperBEAM Balances is empty/unreadable but the connected wallet is the Creator.
   * Often means the atomic-asset Init/Mint credit never landed — listing should run ensureCreatorAssetBalance.
   */
  inferredFromCreator: boolean;
  /** True when HB returned Balances as an empty list/map (synced empty, not still linking). */
  balancesEmptyConfirmed?: boolean;
  /** Profile zone id when asset was minted from a permaweb profile (Bazar/Portal pattern). */
  profileId?: string | null;
  /** Metadata / Bootloader edition size (may exceed sum of Balances when Mint never credited all). */
  totalSupply?: number;
  /** Copies currently held by non-wallet addresses (orderbook escrow, buyers, etc.). */
  escrowedCopies?: number;
  /** max(0, totalSupply - sum(Balances)) — editions tagged but not credited yet. */
  uncreditedCopies?: number;
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

/** Wallet + profile zone holdings the seller controls (asset Balances keys). */
function parseSellerControlledCopies(
  balances: unknown,
  walletAddress: string,
  profileId?: string | null
): number {
  const wallet = normalizeAddr(walletAddress);
  const profile = normalizeAddr(profileId) || null;
  const fromWallet = parseBalanceMap(balances, wallet);
  if (!profile || profile === wallet) return fromWallet;
  return fromWallet + parseBalanceMap(balances, profile);
}

/** Sum all holder quantities in a Balances map/list (excludes commitments). */
function sumBalanceMap(balances: unknown): number {
  if (balances == null) return 0;
  if (Array.isArray(balances)) {
    let total = 0;
    for (const entry of balances) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const qty = Number(row.balance ?? row.Balance ?? row.quantity ?? row.Quantity ?? 0);
      if (Number.isFinite(qty) && qty > 0) total += Math.floor(qty);
    }
    return total;
  }
  if (typeof balances === 'object') {
    let total = 0;
    for (const [key, raw] of Object.entries(balances as Record<string, unknown>)) {
      if (/^(commitments|status|ao-types)$/i.test(key)) continue;
      const n = Number(raw ?? 0);
      if (Number.isFinite(n) && n > 0) total += Math.floor(n);
    }
    return total;
  }
  return 0;
}

/** True when Balances is a real holder map (not +link / missing) — includes confirmed zeros. */
function balanceMapHasHolders(balances: unknown): boolean {
  if (Array.isArray(balances)) return balances.length > 0;
  if (!balances || typeof balances !== 'object') return false;
  return (
    Object.keys(balances as Record<string, unknown>).filter(
      (k) => !/^(commitments|status|ao-types)$/i.test(k)
    ).length > 0
  );
}

function supplyBreakdown(
  balances: unknown,
  walletAddress: string,
  totalSupply: number,
  profileId?: string | null
): Pick<SellerAssetBalance, 'escrowedCopies' | 'uncreditedCopies' | 'totalSupply'> {
  const sellerCopies = parseSellerControlledCopies(balances, walletAddress, profileId);
  const summed = sumBalanceMap(balances);
  const escrowedCopies = Math.max(0, summed - sellerCopies);
  const supply = Math.max(0, Math.floor(totalSupply || 0));
  return {
    totalSupply: supply > 0 ? supply : undefined,
    escrowedCopies,
    uncreditedCopies: supply > 0 ? Math.max(0, supply - summed) : undefined,
  };
}

function readTotalSupply(json: Record<string, unknown> | null | undefined): number {
  if (!json) return 0;
  const candidates = [
    json.TotalSupply,
    json.totalSupply,
    json['Bootloader-TotalSupply'],
    json.BootloaderTotalSupply,
    json.Totalsupply,
    json.totalsupply,
    json['StreamVault-Edition-Supply'],
    json.EditionSupply,
    json.editionSupply,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const meta = json.Metadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    const fromMeta = Number(
      m.Totalsupply ??
        m.TotalSupply ??
        m.totalSupply ??
        m['StreamVault-Edition-Supply'] ??
        m.EditionSupply ??
        0
    );
    if (Number.isFinite(fromMeta) && fromMeta > 0) return Math.floor(fromMeta);
  }
  return 0;
}

/** Spawn/boot tags are reliable when HB Metadata/Balances are linked, empty, or 508 on fractional assets. */
const processSupplyTagCache = new Map<string, number>();

async function fetchAssetSupplyFromProcessTags(assetId: string): Promise<number> {
  const id = String(assetId || '').trim();
  if (!id) return 0;
  const cached = processSupplyTagCache.get(id);
  if (cached != null) return cached;
  try {
    const json = await fetchArweaveL1Graphql({
      query: `
        query StreamVaultAssetSupplyTags($id: ID!) {
          transaction(id: $id) {
            id
            tags { name value }
          }
        }
      `,
      variables: { id },
      timeoutMs: 6_000,
    });
    const tags: Array<{ name?: string; value?: string }> = json?.data?.transaction?.tags ?? [];
    const byName = new Map(
      tags
        .filter((t) => t?.name && t.value != null)
        .map((t) => [String(t.name), String(t.value)] as const)
    );
    for (const key of [
      'StreamVault-Edition-Supply',
      'Bootloader-TotalSupply',
      'TotalSupply',
      'Totalsupply',
      'Quantity',
    ]) {
      const n = Number(byName.get(key) || 0);
      if (Number.isFinite(n) && n > 0) {
        const supply = Math.floor(n);
        processSupplyTagCache.set(id, supply);
        return supply;
      }
    }
  } catch {
    // ignore — callers may still have HB Metadata
  }
  return 0;
}

/**
 * HyperBEAM often returns Balances+link / Metadata+link instead of inline maps.
 * Follow those subpaths when present so Totalsupply and holdings are readable.
 */
async function hydrateHyperbeamAssetLinks(
  assetId: string,
  json: Record<string, unknown> | null
): Promise<Record<string, unknown> | null> {
  if (!json) return null;
  const out: Record<string, unknown> = { ...json };

  const needsMeta =
    out.Metadata == null &&
    (typeof out['Metadata+link'] === 'string' || typeof out['metadata+link'] === 'string');
  const needsBalances =
    out.Balances == null &&
    out.balances == null &&
    (typeof out['Balances+link'] === 'string' || typeof out['balances+link'] === 'string');

  const [meta, balances] = await Promise.all([
    needsMeta ? withBalanceTimeout(fetchHyperbeamAssetMetadata(assetId)) : Promise.resolve(null),
    needsBalances
      ? withBalanceTimeout(
          fetchHyperbeamJson({
            processId: assetId,
            subpath: 'compute/asset/Balances',
            label: 'hb-asset-balances',
            validate: (body) => Boolean(body && typeof body === 'object'),
          })
        )
      : Promise.resolve(null),
  ]);

  if (meta?.json) {
    out.Metadata = meta.json;
    const supply = readTotalSupply(meta.json);
    if (supply > 0 && readTotalSupply(out) <= 0) {
      out.Totalsupply = supply;
      out.TotalSupply = supply;
    }
  }
  if (balances?.json) {
    // HB may wrap the map or return it directly (omit commitments/status).
    const body = balances.json as Record<string, unknown>;
    const nested = body.Balances ?? body.balances;
    out.Balances =
      nested && typeof nested === 'object'
        ? nested
        : Object.fromEntries(
            Object.entries(body).filter(([k]) => !/^(commitments|status|ao-types)$/i.test(k))
          );
  }
  return out;
}

async function resolveAssetTotalSupply(
  assetId: string,
  ...sources: Array<Record<string, unknown> | null | undefined>
): Promise<number> {
  let supply = 0;
  for (const json of sources) {
    supply = Math.max(supply, readTotalSupply(json));
  }
  if (supply > 0) return supply;

  const metadata = await withBalanceTimeout(fetchHyperbeamAssetMetadata(assetId));
  supply = Math.max(supply, readTotalSupply(metadata?.json as Record<string, unknown> | null | undefined));
  if (supply > 0) return supply;

  // Fractional StreamVault editions often break HB compute (508 infinite recursion) while
  // Bootloader-TotalSupply / StreamVault-Edition-Supply on the process spawn remain correct.
  supply = await fetchAssetSupplyFromProcessTags(assetId);
  return supply > 0 ? supply : 0;
}

/** True when HB Balances field is present but has no holder entries (Init/Mint never credited). */
function isConfirmedEmptyBalances(balances: unknown): boolean {
  if (balances == null) return false;
  if (Array.isArray(balances)) return balances.length === 0;
  if (typeof balances === 'object') {
    return Object.keys(balances as Record<string, unknown>).filter((k) => !/commit/i.test(k)).length === 0;
  }
  return false;
}

/**
 * Atomic asset Lua (On-Boot gonhUss…) only credits Creator Balances inside Action=Init from Owner.
 * createAtomicAsset spawns with Bootloader tags but does not always send Init on HyperBEAM —
 * HB then shows Balances: [] forever while Metadata.Totalsupply=1. Send Init (then Mint if needed)
 * so Transfer-to-orderbook can succeed.
 */
export async function ensureCreatorAssetBalance(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  creatorHint?: string | null;
  deps: ReturnType<typeof buildUcmDeps>;
  onStatus?: (status: UcmListingStatus) => void;
  /**
   * Skip balance/HB preflight and open Wander immediately.
   * Use when the UI already confirmed empty Balances / inferred creator ownership —
   * preflight Portal dryruns burn the browser user-gesture window so Wander never pops.
   */
  skipPreflightReads?: boolean;
  /** Copies already inferred by the caller (avoids another HB Metadata round-trip before Init). */
  inferredCopies?: number;
}): Promise<SellerAssetBalance> {
  const wallet = normalizeAddr(args.walletAddress);
  const profileId = normalizeAddr(args.profileId) || null;
  const creatorHint = normalizeAddr(args.creatorHint);
  let current: SellerAssetBalance;
  let hbJson: Record<string, unknown> | null = null;

  if (args.skipPreflightReads) {
    current = {
      copies: Math.max(1, Math.floor(args.inferredCopies || 1)),
      inferredFromCreator: true,
      balancesEmptyConfirmed: true,
      profileId,
    };
  } else {
    current = await fetchSellerAssetBalance(args);
    if (!current.inferredFromCreator && current.copies > 0) return current;
    const hb = await withBalanceTimeout(fetchHyperbeamAssetState(args.assetId));
    hbJson = (hb?.json || null) as Record<string, unknown> | null;
    const creator = readCreatorFromJson(hbJson) || creatorHint || wallet;
    // Owner of Init may be wallet while Creator tag is the profile zone.
    const allowed =
      Boolean(wallet) &&
      (wallet === creator || (Boolean(profileId) && profileId === creator));
    if (!allowed) return current;
  }

  if (!wallet) return current;
  // Owner wallet may differ from Creator when Creator is the profile zone id.
  if (creatorHint && wallet !== creatorHint && (!profileId || creatorHint !== profileId)) {
    return current;
  }
  if (!args.deps.signer) return current;

  const supply = Math.max(
    1,
    current.copies,
    args.skipPreflightReads
      ? Math.floor(args.inferredCopies || current.copies || 1)
      : await resolveAssetTotalSupply(args.assetId, hbJson)
  );

  // Open Wander immediately — do not await Portal before signDataItem.
  args.onStatus?.({
    processing: true,
    success: false,
    message:
      'Approve Init in Wander (extension popup) to credit your creator balance. HyperBEAM Balances stay empty until this is signed…',
  });
  try {
    await withWanderSignTimeout(
      args.deps.ao.message({
        process: args.assetId,
        signer: args.deps.signer,
        tags: [
          { name: 'Action', value: 'Init' },
          { name: 'Message-Timestamp', value: Date.now().toString() },
        ],
      }),
      'Init'
    );
  } catch (error: any) {
    if (isWanderSignFailure(error)) throw error;
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Init message failed (${error?.message || 'unknown'}) — trying Mint…`,
    });
  }

  args.onStatus?.({
    processing: true,
    success: false,
    message: 'Warming HyperBEAM (Bazar/Portal) before balance check…',
  });
  await hydrateProcessOnPortalAndBazar(args.assetId, {
    waitBetweenMs: 0,
    timeoutMs: 8_000,
    retries: 1,
    includeOperator: true,
    operatorBackground: true,
  }).catch(() => {});
  await sleep(1200);
  current = await fetchSellerAssetBalance(args);
  if (!current.inferredFromCreator && current.copies > 0) return current;

  args.onStatus?.({
    processing: true,
    success: false,
    message: `Approve Mint in Wander — minting ${supply} cop${supply === 1 ? 'y' : 'ies'} (Balances still empty after Init)…`,
  });
  try {
    await withWanderSignTimeout(
      args.deps.ao.message({
        process: args.assetId,
        signer: args.deps.signer,
        tags: [
          { name: 'Action', value: 'Mint' },
          { name: 'Message-Timestamp', value: Date.now().toString() },
        ],
        data: JSON.stringify({ Quantity: String(supply) }),
      }),
      'Mint'
    );
    args.onStatus?.({
      processing: true,
      success: false,
      message: 'Mint signed — warming HyperBEAM Balances…',
    });
  } catch (error: any) {
    if (isWanderSignFailure(error)) throw error;
    throw new Error(
      `Could not credit creator balance on this asset (Init/Mint failed: ${error?.message || 'unknown'}). ` +
        `HyperBEAM shows Balances: [] — listing Transfer cannot succeed until your wallet is credited.`
    );
  }

  await hydrateProcessOnPortalAndBazar(args.assetId, {
    waitBetweenMs: 0,
    timeoutMs: 8_000,
    retries: 1,
    includeOperator: true,
    operatorBackground: true,
  }).catch(() => {});
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(1500);
    current = await fetchSellerAssetBalance(args);
    if (!current.inferredFromCreator && current.copies > 0) {
      args.onStatus?.({
        processing: true,
        success: false,
        message: `Creator balance confirmed: ${current.copies} cop${current.copies === 1 ? 'y' : 'ies'}.`,
      });
      return current;
    }
    args.onStatus?.({
      processing: true,
      success: false,
      message: `Waiting for Balances to update after Mint… (${attempt + 1}/8)`,
    });
  }

  throw new Error(
    `Init/Mint did not credit Balances on HyperBEAM (still empty/uncredited after Mint). ` +
      `Expected ~${supply} cop${supply === 1 ? 'y' : 'ies'} for creator ${wallet.slice(0, 8)}…. ` +
      `Listing Transfer is blocked until Balances show a real wallet credit.`
  );
}

/** Read seller balance for an atomic asset from HyperBEAM (whole copies). */
const BALANCE_READ_TIMEOUT_MS = 4_000;

async function dryrunAssetInfo(assetId: string): Promise<Record<string, unknown> | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;
  const node = resolveAoNode();
  const readUrls = await resolveHbReadNodeUrlsForProcess(id).catch(() => resolveHbReadNodeUrls());
  const preferred = new Set(
    (await resolvePreferredNodesForProcess(id).catch(() => [])).map((n) =>
      String(n.url || '').replace(/\/+$/, '')
    )
  );
  const urls = readUrls.slice(0, 3).map((u) => u.replace(/\/+$/, ''));
  if (urls.length === 0) return null;

  type Cand = { json: Record<string, unknown>; preferred: boolean; rich: boolean };
  const candidates = await Promise.all(
    urls.map(async (url): Promise<Cand | null> => {
      try {
        const ao = connect({
          MODE: 'mainnet',
          URL: url,
          SCHEDULER: node.scheduler,
        } as any);
        const res: any = await Promise.race([
          ao.dryrun({
            process: id,
            tags: [{ name: 'Action', value: 'Info' }],
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_800)),
        ]);
        if (!res) return null;
        const parsed = parseInfoData(res?.Messages?.[0]);
        if (!parsed || typeof parsed !== 'object') return null;
        const json = parsed as Record<string, unknown>;
        return {
          json,
          preferred: preferred.has(url),
          rich: hyperbeamBalancesHaveHoldings(json),
        };
      } catch {
        return null;
      }
    })
  );

  const hits = candidates.filter(Boolean) as Cand[];
  if (hits.length === 0) return null;
  // Prefer scheduler-matching node, then any non-empty Balances peer, then first hit.
  hits.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (a.rich !== b.rich) return a.rich ? -1 : 1;
    return 0;
  });
  return hits[0].json;
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
  /** L1 / UI creator hint when HB Creator field is still missing. */
  creatorHint?: string | null;
}): Promise<SellerAssetBalance> {
  const wallet = normalizeAddr(args.walletAddress);
  const profileId = normalizeAddr(args.profileId) || null;
  const explicitHolder = normalizeAddr(args.balanceHolderId) || null;
  const creatorHint = normalizeAddr(args.creatorHint) || null;

  const [hbRaw, dryrunJson] = await Promise.all([
    withBalanceTimeout(fetchHyperbeamAssetState(args.assetId)),
    withBalanceTimeout(dryrunAssetInfo(args.assetId)),
  ]);
  const hbJson = await hydrateHyperbeamAssetLinks(
    args.assetId,
    (hbRaw?.json || null) as Record<string, unknown> | null
  );
  const metaJson = dryrunJson || hbJson;
  const totalSupply = await resolveAssetTotalSupply(args.assetId, metaJson, hbJson, dryrunJson);

  const annotate = (
    base: SellerAssetBalance,
    balances: unknown
  ): SellerAssetBalance => ({
    ...base,
    walletCopies: parseBalanceMap(balances, wallet),
    profileCopies: profileId && profileId !== wallet ? parseBalanceMap(balances, profileId) : 0,
    ...supplyBreakdown(balances, wallet, totalSupply, profileId),
  });

  const finish = (result: SellerAssetBalance, _path: string): SellerAssetBalance => result;

  const readFromJson = (json: Record<string, unknown> | null | undefined): SellerAssetBalance | null => {
    if (!json) return null;
    const balances = json.Balances ?? json.balances;
    const token = json.Token;
    const tokenBalances =
      token && typeof token === 'object'
        ? (token as Record<string, unknown>).Balances
        : null;
    const maps = [balances, tokenBalances].filter((m) => m != null);

    for (const map of maps) {
      // Listing identity checks a specific holder (wallet OR profile).
      if (explicitHolder) {
        const fromHolder = parseBalanceMap(map, explicitHolder);
        if (fromHolder > 0) {
          return annotate(
            {
              copies: fromHolder,
              inferredFromCreator: false,
              profileId: profileId || (explicitHolder === wallet ? null : explicitHolder),
            },
            map
          );
        }
        continue;
      }

      // Default UI path: seller controls wallet-keyed AND profile-keyed Balances.
      const sellerCopies = parseSellerControlledCopies(map, wallet, profileId);
      if (sellerCopies > 0) {
        return annotate({ copies: sellerCopies, inferredFromCreator: false, profileId }, map);
      }
    }

    for (const map of maps) {
      if (balanceMapHasHolders(map)) {
        // Live Balances map has holders (e.g. orderbook escrow) but seller is 0 —
        // never fall through to Totalsupply inference (that was showing false "Balance: 25").
        return annotate({ copies: 0, inferredFromCreator: false, profileId }, map);
      }
    }
    return null;
  };

  const fromDryrun = readFromJson(dryrunJson);
  if (fromDryrun) return finish(fromDryrun, 'dryrun');
  const fromHb = readFromJson(hbJson);
  if (fromHb) return finish(fromHb, 'hb-balances-map');

  const creator =
    readCreatorFromJson(metaJson) ||
    creatorHint ||
    '';

  const emptyConfirmed =
    isConfirmedEmptyBalances(hbJson?.Balances ?? hbJson?.balances) ||
    isConfirmedEmptyBalances(dryrunJson?.Balances ?? dryrunJson?.balances);

  // Creator may be the profile zone id (Bazar / StreamVault) while the wallet owns that zone.
  const creatorIsWallet = Boolean(wallet && creator && wallet === creator);
  const creatorIsProfile = Boolean(profileId && creator && profileId === creator);
  const hintIsWallet = Boolean(wallet && creatorHint && wallet === creatorHint);
  if (creatorIsWallet || creatorIsProfile || hintIsWallet) {
    return finish({
      copies: Math.max(1, totalSupply),
      walletCopies: creatorIsWallet || hintIsWallet ? Math.max(1, totalSupply) : 0,
      profileCopies: creatorIsProfile ? Math.max(1, totalSupply) : 0,
      inferredFromCreator: true,
      balancesEmptyConfirmed: emptyConfirmed || (!hbJson && !dryrunJson),
      profileId,
      totalSupply: totalSupply > 0 ? totalSupply : undefined,
      escrowedCopies: 0,
      uncreditedCopies: totalSupply > 0 ? totalSupply : undefined,
    }, creatorIsProfile ? 'infer-creator-profile' : 'infer-creator');
  }

  const deps = buildUcmDeps(null);
  const holdersToProbe = explicitHolder
    ? [explicitHolder]
    : [wallet, profileId].filter((id, i, arr): id is string => Boolean(id) && arr.indexOf(id) === i);

  for (const holder of holdersToProbe) {
    const fromBalanceAction = await withBalanceTimeout(
      readHolderBalanceViaDryrun(args.assetId, holder, deps)
    );
    if (fromBalanceAction != null && fromBalanceAction > 0) {
      return finish({
        copies: fromBalanceAction,
        walletCopies: holder === wallet ? fromBalanceAction : 0,
        profileCopies: holder === profileId ? fromBalanceAction : 0,
        inferredFromCreator: false,
        profileId,
        totalSupply: totalSupply > 0 ? totalSupply : undefined,
      }, holder === profileId ? 'dryrun-profile-Balance' : 'dryrun-Balance-action');
    }
  }

  return finish({
    copies: 0,
    walletCopies: 0,
    profileCopies: 0,
    inferredFromCreator: false,
    profileId,
    totalSupply: totalSupply > 0 ? totalSupply : undefined,
  }, 'zero-fallback');
}

/** Poll until seller balance is confirmed on-chain (not creator-inferred). */
export async function waitForConfirmedSellerBalance(args: {
  assetId: string;
  walletAddress: string;
  profileId?: string | null;
  balanceHolderId?: string | null;
  creatorHint?: string | null;
  minCopies?: number;
  timeoutMs?: number;
  onStatus?: (status: UcmListingStatus) => void;
}): Promise<SellerAssetBalance> {
  const minCopies = Math.max(1, Math.floor(args.minCopies || 1));
  // Creators with a wallet hint can list immediately on inferred supply — do not burn user-gesture
  // time waiting for empty HB Balances maps before Wander ever opens.
  const creatorHint = normalizeAddr(args.creatorHint);
  const wallet = normalizeAddr(args.walletAddress);
  const timeoutMs =
    args.timeoutMs ??
    (creatorHint && wallet && creatorHint === wallet ? 2_500 : 20_000);
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
        message: `Proceeding with ${balance.copies} cop${balance.copies === 1 ? 'y' : 'ies'} (HyperBEAM balance still syncing) — opening Wander next…`,
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
    await sleep(2000);
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
  // Creator wallet fallback even if HB never returned Creator/Totalsupply in time.
  if (creatorHint && wallet && creatorHint === wallet) {
    args.onStatus?.({
      processing: true,
      success: false,
      message: 'Using creator ownership (HyperBEAM still syncing) — opening Wander next…',
    });
    return { copies: minCopies, inferredFromCreator: true, profileId: args.profileId || null };
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
  debugUcm('cancelOrder:prepared', {
    assetId: args.assetId,
    orderbookId: args.orderbookId,
    orderId: args.orderId,
    quoteToken,
    walletAddress: args.walletAddress,
    profileId: args.profileId || null,
    listingCreatorId: listingIdentity.listingCreatorId || null,
    args: cancelArgs,
    expectedEffect:
      'Orderbook Cancel-Order removes ask and sends asset Transfer back to the order Creator; token process emits Credit/Debit notices.',
  });

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
