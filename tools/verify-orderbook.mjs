#!/usr/bin/env node

const ASSET_ID = arg('--asset');
let ORDERBOOK_ID = arg('--orderbook');
let ACTIVITY_ID = arg('--activity');

const HB_NODES = ['https://app-1.forward.computer', 'https://hb.portalinto.com'];
const GQL = 'https://arweave-search.goldsky.com/graphql';
const ACTIVITY_WINDOW_MS = 30000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function isId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.trim());
}

async function fetchJson(url, init = {}, timeoutMs = 10000) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { url, status: res.status, ok: res.ok, error: 'non-json', preview: text.slice(0, 240) };
    }
    return { url, status: res.status, ok: res.ok, json };
  } catch (e) {
    return { url, status: 0, ok: false, error: e.message || String(e) };
  }
}

async function gql(query, variables) {
  return fetchJson(
    GQL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    },
    12000
  );
}

function parseData(data) {
  if (!data) return null;
  if (typeof data === 'object') return data;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function unwrapInfo(json) {
  if (!json || typeof json !== 'object') return null;
  const messages = json.Messages || json.results?.raw?.Messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const parsed = parseData(msg?.Data);
      if (parsed) return parsed;
    }
  }
  const outbox = json.results?.outbox;
  if (outbox && typeof outbox === 'object') {
    for (const entry of Object.values(outbox)) {
      const parsed = parseData(entry?.Data);
      if (parsed) return parsed;
    }
  }
  return json.orderbook && typeof json.orderbook === 'object' ? json.orderbook : json;
}

function summarizeBook(info) {
  const row = unwrapInfo(info);
  if (!row) return null;
  const activity =
    row.ActivityProcess || row.activityProcess || row.ACTIVITY_PROCESS || row['Activity-Process'] || null;
  const books = Array.isArray(row.Orderbook)
    ? row.Orderbook
    : row.Orderbook
      ? [row.Orderbook]
      : row.Pair
        ? [row]
        : [];
  return {
    name: row.Name,
    activity,
    activityValid: isId(activity),
    pairCount: books.length,
    pairs: books.map((book) => ({
      pair: book.Pair || book.pair,
      asks: Array.isArray(book.Asks || book.asks) ? (book.Asks || book.asks).length : 0,
      bids: Array.isArray(book.Bids || book.bids) ? (book.Bids || book.bids).length : 0,
      askRows: (book.Asks || book.asks || []).slice(0, 5),
    })),
  };
}

function summarizeRaw(json) {
  if (!json || typeof json !== 'object') return json;
  const out = {};
  for (const key of Object.keys(json).slice(0, 20)) {
    const value = json[key];
    if (value == null) out[key] = value;
    else if (Array.isArray(value)) out[key] = `[array:${value.length}]`;
    else if (typeof value === 'object') out[key] = `{${Object.keys(value).slice(0, 12).join(',')}}`;
    else out[key] = String(value).slice(0, 120);
  }
  return out;
}

async function inspectOrderbook() {
  if (!ORDERBOOK_ID && ASSET_ID) {
    const discovered = await discoverByAsset(ASSET_ID);
    ORDERBOOK_ID = discovered.orderbookId;
    ACTIVITY_ID = ACTIVITY_ID || discovered.activityId;
  }

  console.log('Asset:', ASSET_ID || '(none)');
  console.log('Orderbook:', ORDERBOOK_ID);
  console.log('Activity hint:', ACTIVITY_ID || '(none)');

  console.log('\n=== Spawn tags ===');
  const spawn = await gql(
    `query($ids:[ID!]!){transactions(ids:$ids){edges{node{id block{height timestamp} tags{name value}}}}}`,
    { ids: [ORDERBOOK_ID, ACTIVITY_ID].filter(Boolean) }
  );
  if (spawn.error) console.log('GQL error:', spawn.error);
  for (const edge of spawn.json?.data?.transactions?.edges || []) {
    console.log('\n' + edge.node.id);
    for (const tag of edge.node.tags || []) {
      if (/^(UCM|Asset|Activity|Process|Scheduler|Authority|Module)/i.test(tag.name)) {
        console.log(`  ${tag.name}: ${tag.value}`);
      }
    }
  }

  console.log('\n=== Messages targeting orderbook ===');
  const messages = await gql(
    `query($recipients:[String!]!,$first:Int!){transactions(recipients:$recipients,first:$first,sort:HEIGHT_DESC){edges{node{id owner{address} block{height timestamp} tags{name value}}}}}`,
    { recipients: [ORDERBOOK_ID], first: 12 }
  );
  if (messages.error) console.log('GQL error:', messages.error);
  for (const edge of messages.json?.data?.transactions?.edges || []) {
    const node = edge.node;
    console.log('\n' + node.id);
    console.log('  owner:', node.owner?.address || '(none)');
    for (const tag of node.tags || []) {
      if (/^(Action|From|Sender|Recipient|Quantity|Status|Message|Reference|X-|Data-Protocol)/i.test(tag.name)) {
        console.log(`  ${tag.name}: ${tag.value}`);
      }
    }
  }

  console.log('\n=== Orderbook Info ===');
  for (const node of HB_NODES) {
    const base = node.replace(/\/+$/, '');
    const url = `${base}/${ORDERBOOK_ID}~process@1.0/as=execution/compute&Action=Info`;
    const res = await fetchJson(url, { method: 'POST' }, 10000);
    console.log('\n' + url + ` (HTTP ${res.status})`);
    if (res.error) {
      console.log('  error:', res.error, res.preview || '');
      continue;
    }
    console.log('raw:', JSON.stringify(summarizeRaw(res.json), null, 2));
    console.log(JSON.stringify(summarizeBook(res.json), null, 2));
  }

  console.log('\n=== Orderbook dry-run Info ===');
  for (const node of HB_NODES) {
    const base = node.replace(/\/+$/, '');
    const url = `${base}/dry-run?process-id=${ORDERBOOK_ID}`;
    const res = await fetchJson(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Id: 'verify-orderbook',
          Target: ORDERBOOK_ID,
          Owner: '111111111111111111111111111111111111111111111',
          Tags: [{ name: 'Action', value: 'Info' }],
        }),
      },
      12000
    );
    console.log('\n' + url + ` (HTTP ${res.status})`);
    if (res.error) {
      console.log('  error:', res.error, res.preview || '');
      continue;
    }
    console.log('raw:', JSON.stringify(summarizeRaw(res.json), null, 2));
    console.log(JSON.stringify(summarizeBook(res.json), null, 2));
  }

  console.log('\n=== Orderbook compute/now ===');
  for (const node of HB_NODES) {
    for (const subpath of ['compute/orderbook', 'now/orderbook', 'compute', 'now']) {
      const base = node.replace(/\/+$/, '');
      const url = `${base}/${ORDERBOOK_ID}~process@1.0/${subpath}`;
      const res = await fetchJson(url, {}, 10000);
      console.log('\n' + url + ` (HTTP ${res.status})`);
      if (res.error) {
        console.log('  error:', res.error, res.preview || '');
        continue;
      }
      console.log('raw:', JSON.stringify(summarizeRaw(res.json), null, 2));
      console.log(JSON.stringify(summarizeBook(res.json), null, 2));
    }
  }

  if (ASSET_ID) {
    console.log('\n=== Asset Balances ===');
    for (const node of HB_NODES) {
      const base = node.replace(/\/+$/, '');
      const url = `${base}/${ASSET_ID}~process@1.0/compute/asset`;
      const res = await fetchJson(url, {}, 10000);
      console.log('\n' + url + ` (HTTP ${res.status})`);
      if (res.error) {
        console.log('  error:', res.error, res.preview || '');
        continue;
      }
      const balances = res.json?.Balances || res.json?.balances || res.json?.Token?.Balances;
      console.log(JSON.stringify(balances || null, null, 2));
    }
  }
}

async function discoverByAsset(assetId) {
  const res = await gql(
    `query($tags:[TagFilter!]!,$first:Int!){transactions(tags:$tags,first:$first,sort:HEIGHT_DESC){edges{node{id block{height timestamp} tags{name value}}}}}`,
    { first: 12, tags: [{ name: 'Asset-ID', values: [assetId] }] }
  );
  let orderbookId = null;
  let activityId = null;
  let orderbookNode = null;
  for (const edge of res.json?.data?.transactions?.edges || []) {
    const tags = edge.node.tags || [];
    const role =
      tags.find((t) => t.name === 'UCM-Process')?.value ||
      tags.find((t) => t.name === 'UCM-Role')?.value ||
      '';
    if (/order-?book/i.test(role)) {
      orderbookId = orderbookId || edge.node.id;
      orderbookNode = orderbookNode || edge.node;
      activityId =
        activityId ||
        tags.find((t) => /^Activity-Process/.test(t.name) || t.name === 'ActivityProcess')?.value ||
        null;
    }
    if (/activity|asset-activity/i.test(role)) {
      activityId = activityId || edge.node.id;
    }
  }
  if (!activityId && orderbookNode) {
    activityId = await discoverActivityForOrderbookNode(orderbookNode);
  }
  return { orderbookId, activityId };
}

async function discoverActivityForOrderbookNode(orderbookNode) {
  const orderbookTs = Number(
    (orderbookNode.tags || []).find((t) => t.name === 'Process-Timestamp')?.value || 0
  );
  const blockHeight = orderbookNode.block?.height;
  const candidates = [];
  if (blockHeight) {
    const byBlock = await gql(
      `query($blockMin:Int!,$blockMax:Int!,$tags:[TagFilter!]!,$first:Int!){transactions(block:{min:$blockMin,max:$blockMax},tags:$tags,first:$first,sort:HEIGHT_DESC){edges{node{id block{height timestamp} tags{name value}}}}}`,
      {
        blockMin: blockHeight,
        blockMax: blockHeight,
        first: 16,
        tags: [{ name: 'UCM-Process', values: ['Asset-Activity'] }],
      }
    );
    candidates.push(...(byBlock.json?.data?.transactions?.edges || []).map((e) => e.node));
  }
  const recent = await gql(
    `query($tags:[TagFilter!]!,$first:Int!){transactions(tags:$tags,first:$first,sort:HEIGHT_DESC){edges{node{id block{height timestamp} tags{name value}}}}}`,
    { first: 40, tags: [{ name: 'UCM-Process', values: ['Asset-Activity'] }] }
  );
  candidates.push(...(recent.json?.data?.transactions?.edges || []).map((e) => e.node));

  let best = null;
  for (const node of candidates) {
    const ts = Number((node.tags || []).find((t) => t.name === 'Process-Timestamp')?.value || 0);
    if (!ts || !orderbookTs) continue;
    const delta = Math.abs(ts - orderbookTs);
    if (delta <= ACTIVITY_WINDOW_MS && (!best || delta < best.delta)) {
      best = { id: node.id, delta, ts, block: node.block?.height };
    }
  }
  if (best) {
    console.log(`Discovered paired activity by timestamp: ${best.id} (delta ${best.delta}ms)`);
  }
  return best?.id || null;
}

if (!ORDERBOOK_ID && !ASSET_ID) {
  console.error('Usage: node tools/verify-orderbook.mjs --asset <id> or --orderbook <id> [--activity <id>]');
  process.exit(1);
}

inspectOrderbook().catch((e) => {
  console.error(e);
  process.exit(1);
});
