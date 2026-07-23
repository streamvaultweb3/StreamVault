#!/usr/bin/env node
/**
 * Verify atomic asset balance for a StreamVault audio tx or asset process id.
 * Usage: node tools/verify-asset-balance.mjs --audio 79E9h62j... [--wallet jt19...]
 */
const AUDIO_TX = process.argv.includes('--audio')
  ? process.argv[process.argv.indexOf('--audio') + 1]
  : null;
const ASSET_ID = process.argv.includes('--asset')
  ? process.argv[process.argv.indexOf('--asset') + 1]
  : null;
const WALLET = process.argv.includes('--wallet')
  ? process.argv[process.argv.indexOf('--wallet') + 1]
  : null;

const GQL = 'https://arweave-search.goldsky.com/graphql';
const HB_NODES = [
  'https://hb.portalinto.com',
  'https://app-1.forward.computer',
];
const MU = 'https://hb.portalinto.com';

async function gql(query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(12000),
  });
  return res.json();
}

async function hbAssetJson(node, assetId) {
  const base = node.replace(/\/+$/, '');
  const url = `${base}/${assetId}~process@1.0/compute/asset`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { node, status: res.status, error: 'non-json', preview: text.slice(0, 200) };
    }
    return { node, status: res.status, json };
  } catch (e) {
    return { node, status: 0, error: String(e.message || e) };
  }
}

async function dryrunInfo(assetId) {
  const url = `${MU.replace(/\/+$/, '')}/dry-run?process-id=${assetId}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Id: 'verify-balance',
        Target: assetId,
        Owner: '111111111111111111111111111111111111111111111',
        Tags: [{ name: 'Action', value: 'Info' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: res.status, error: 'non-json', preview: text.slice(0, 200) };
    }
    const data = body?.Messages?.[0]?.Data;
    let info = null;
    if (data) {
      try {
        info = JSON.parse(data);
      } catch {
        info = data;
      }
    }
    return { status: res.status, info, raw: body };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function dryrunBalance(assetId, holder) {
  const url = `${MU.replace(/\/+$/, '')}/dry-run?process-id=${assetId}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Id: 'verify-balance',
        Target: assetId,
        Owner: '111111111111111111111111111111111111111111111',
        Tags: [
          { name: 'Action', value: 'Balance' },
          { name: 'Recipient', value: holder },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const body = JSON.parse(text);
    const msg = body?.Messages?.[0];
    const data = msg?.Data;
    const tags = msg?.Tags || [];
    const balanceTag = tags.find((t) => t.name === 'Balance' || t.name === 'Quantity');
    return {
      status: res.status,
      data,
      balanceTag: balanceTag?.value,
      tags: tags.map((t) => `${t.name}=${t.value}`).join(', '),
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function parseBalanceMap(balances, addr) {
  if (!balances || !addr) return 0;
  if (Array.isArray(balances)) {
    for (const row of balances) {
      if (!row || typeof row !== 'object') continue;
      const a = String(row.Address || row.address || row.Recipient || row.recipient || '').trim();
      if (a.toLowerCase() === addr.toLowerCase()) {
        return Number(row.Balance ?? row.balance ?? row.Quantity ?? row.quantity ?? 0) || 0;
      }
    }
    return 0;
  }
  if (typeof balances === 'object') {
    const v = balances[addr] ?? balances[addr.toLowerCase()];
    return Number(v) || 0;
  }
  return 0;
}

function readCreator(json) {
  if (!json) return null;
  return json.Creator || json.creator || null;
}

function readTotalSupply(json) {
  if (!json) return 0;
  const candidates = [
    json.TotalSupply,
    json.totalSupply,
    json.Totalsupply,
    json.totalsupply,
    json.Supply,
    json.supply,
    json['Bootloader-TotalSupply'],
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const meta = json.Metadata;
  if (meta && typeof meta === 'object') {
    const fromMeta = Number(meta.Totalsupply ?? meta.TotalSupply ?? meta.totalSupply ?? 0);
    if (Number.isFinite(fromMeta) && fromMeta > 0) return Math.floor(fromMeta);
  }
  return 0;
}

async function fetchMetadataSupply(assetId) {
  for (const node of HB_NODES) {
    const base = node.replace(/\/+$/, '');
    const url = `${base}/${assetId}~process@1.0/compute/asset/Metadata`;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const supply = readTotalSupply(json);
      if (supply > 0) return { node, supply, json };
    } catch {
      // try next
    }
  }
  return { node: null, supply: 0, json: null };
}

async function resolveAssetId(audioTx) {
  const j = await gql(
    `query($tags:[TagFilter!]!,$first:Int!){transactions(tags:$tags,first:$first,sort:HEIGHT_DESC){edges{node{id owner{address} tags{name value}}}}}`,
    {
      first: 5,
      tags: [
        { name: 'Track-AudioTx', values: [audioTx] },
        { name: 'App-Name', values: ['StreamVault'] },
      ],
    }
  );
  const edges = j?.data?.transactions?.edges ?? [];
  for (const e of edges) {
    const id = String(e?.node?.id || '').trim();
    if (id) return { assetId: id, owner: e.node.owner?.address, tags: e.node.tags };
  }
  // fallback: tx itself might be asset if Type=Process
  const tx = await gql(`query($id:ID!){transaction(id:$id){id owner{address} tags{name value}}}`, { id: audioTx });
  const node = tx?.data?.transaction;
  const trackId = node?.tags?.find((t) => t.name === 'Track-Id')?.value;
  if (trackId) return { assetId: trackId, owner: node.owner?.address, tags: node.tags, via: 'Track-Id tag' };
  return { assetId: null, owner: node?.owner?.address, tags: node?.tags };
}

async function main() {
  let assetId = ASSET_ID;
  let audioOwner = null;
  let resolveMeta = null;

  if (!assetId && AUDIO_TX) {
    resolveMeta = await resolveAssetId(AUDIO_TX);
    assetId = resolveMeta.assetId;
    audioOwner = resolveMeta.owner;
    console.log('Audio TX:', AUDIO_TX);
    console.log('Resolved asset id:', assetId || '(none)');
    if (resolveMeta.via) console.log('Via:', resolveMeta.via);
    console.log('L1 tx owner:', audioOwner);
    if (resolveMeta.tags) {
      for (const t of resolveMeta.tags) {
        if (['Track-Id', 'Asset-Id', 'Creator', 'Type', 'Data-Protocol'].includes(t.name)) {
          console.log(`  ${t.name}: ${t.value}`);
        }
      }
    }
  }

  if (!assetId) {
    console.error('No asset id — pass --asset or --audio');
    process.exit(1);
  }

  console.log('\n=== HyperBEAM Metadata subpath ===');
  for (const node of HB_NODES) {
    const r = await hbAssetJson(node, assetId);
    // reuse helper with Metadata subpath
    const base = node.replace(/\/+$/, '');
    const url = `${base}/${assetId}~process@1.0/compute/asset/Metadata`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const json = await res.json();
      console.log(`\n${url} (HTTP ${res.status})`);
      console.log('  Totalsupply:', json?.Totalsupply ?? json?.TotalSupply);
      console.log('  Audiotxid:', json?.Audiotxid ?? json?.AudioTxId);
    } catch (e) {
      console.log(`${url} error:`, e.message);
    }
  }

  console.log('\n=== HyperBEAM asset state ===');
  for (const node of HB_NODES) {
    const r = await hbAssetJson(node, assetId);
    console.log(`\n${node} (HTTP ${r.status})`);
    if (r.error) {
      console.log('  error:', r.error, r.preview || '');
      continue;
    }
    const j = r.json;
    const creator = readCreator(j);
    const supply = readTotalSupply(j);
    const balances = j?.Balances ?? j?.balances;
    console.log('  Creator:', creator);
    console.log('  TotalSupply:', supply);
    console.log('  Balances:', JSON.stringify(balances)?.slice(0, 500));
    if (WALLET || audioOwner) {
      for (const w of [WALLET, audioOwner].filter(Boolean)) {
        console.log(`  wallet ${w.slice(0, 12)}… balance:`, parseBalanceMap(balances, w));
      }
    }
  }

  console.log('\n=== Dry-run Info (Portal MU) ===');
  const info = await dryrunInfo(assetId);
  if (info.error) console.log('error:', info.error, info.preview || '');
  else {
    console.log('HTTP', info.status);
    console.log('Creator:', readCreator(info.info));
    console.log('TotalSupply:', readTotalSupply(info.info));
    console.log('Balances:', JSON.stringify(info.info?.Balances ?? info.info?.balances)?.slice(0, 500));
  }

  const holders = [WALLET, audioOwner].filter(Boolean);
  const uniqueHolders = [...new Set(holders.map((h) => h.toLowerCase()))].map(
    (lower) => holders.find((h) => h.toLowerCase() === lower)
  );

  console.log('\n=== Dry-run Balance action ===');
  for (const h of uniqueHolders) {
    const bal = await dryrunBalance(assetId, h);
    console.log(`Recipient ${h}:`);
    if (bal.error) console.log('  error:', bal.error);
    else console.log('  Data:', bal.data, 'tag:', bal.balanceTag, bal.tags ? `(${bal.tags})` : '');
  }

  // Prefer Bazar HB when Portal times out (same race strategy as app).
  let meta = info.info || null;
  let metaNode = null;
  for (const node of [...HB_NODES].reverse()) {
    const r = await hbAssetJson(node, assetId);
    if (r.json && !r.error) {
      meta = r.json;
      metaNode = node;
      break;
    }
  }
  const creator = readCreator(meta) || audioOwner || WALLET;
  let supply = readTotalSupply(meta);
  if (supply <= 0) {
    const fromMetaPath = await fetchMetadataSupply(assetId);
    supply = fromMetaPath.supply;
    if (fromMetaPath.node) metaNode = fromMetaPath.node;
  }
  console.log('\n=== StreamVault inference (fetchSellerAssetBalance logic) ===');
  console.log('State source:', metaNode || '(dryrun/none)');
  console.log('Creator:', creator);
  console.log('Resolved supply (incl. Metadata.Totalsupply):', supply);
  for (const w of uniqueHolders) {
    const fromMap = parseBalanceMap(meta?.Balances ?? meta?.balances, w);
    const creatorMatch = Boolean(w && creator && w === creator);
    const inferred =
      creatorMatch && fromMap === 0 ? Math.max(1, supply || 0) : 0;
    console.log(
      `Wallet ${w.slice(0, 12)}…: map=${fromMap}, creatorMatch=${creatorMatch}, supply=${supply}, inferred=${inferred}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
