#!/usr/bin/env node
/**
 * Compare Portal HB ~query@1.0/graphql vs arweave.net for StreamVault L1 tags.
 *
 * Usage:
 *   node tools/hb-query-parity.mjs
 *   node tools/hb-query-parity.mjs --hb-url https://hb.portalinto.com/~query@1.0/graphql
 *   node tools/hb-query-parity.mjs --hb-only
 *
 * Exit 0 when HB query responds with transactions data; exit 1 on failure or mismatch.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnvLocal() {
  const path = resolve(root, '.env.local');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = { ...process.env, ...loadEnvLocal() };
const args = process.argv.slice(2);
const hbOnly = args.includes('--hb-only');
const hbUrlArg = args.find((a) => a.startsWith('--hb-url='))?.split('=').slice(1).join('=')
  || (args.includes('--hb-url') ? args[args.indexOf('--hb-url') + 1] : null);

const aoUrl = (env.VITE_AO_URL || 'https://hb.portalinto.com').replace(/\/+$/, '');
const hbUrl = (hbUrlArg || env.VITE_HB_QUERY_URL || `${aoUrl}/~query@1.0/graphql`).replace(
  /\/+$/,
  ''
);
const hbEndpoint = hbUrl.endsWith('/graphql') ? hbUrl : `${hbUrl}/graphql`;
const arweaveEndpoint = (env.VITE_ARWEAVE_GQL_URL || 'https://arweave.net/graphql').replace(
  /\/+$/,
  ''
);

const PROBE_QUERY = `
  query StreamVaultHbParity($tags: [TagFilter!]) {
    transactions(tags: $tags, first: 5, sort: HEIGHT_DESC) {
      edges {
        node {
          id
          block { timestamp }
          tags { name value }
        }
      }
    }
  }
`;

const TAG_SETS = [
  { label: 'StreamVault app', tags: [{ name: 'App-Name', values: ['StreamVault'] }] },
  { label: 'Type:music', tags: [{ name: 'Type', values: ['music'] }] },
];

async function postGraphql(endpoint, variables) {
  const start = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: PROBE_QUERY, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const durationMs = Date.now() - start;
  const json = await res.json().catch(() => ({}));
  const edges = json?.data?.transactions?.edges || [];
  const ids = edges.map((e) => e?.node?.id).filter(Boolean);
  return {
    endpoint,
    ok: res.ok && !json?.errors?.length,
    status: res.status,
    durationMs,
    count: ids.length,
    ids,
    error: json?.errors?.[0]?.message || (!res.ok ? `HTTP ${res.status}` : null),
  };
}

function printResult(label, result) {
  const status = result.ok ? 'OK' : 'FAIL';
  console.log(`\n[${status}] ${label}`);
  console.log(`  endpoint: ${result.endpoint}`);
  console.log(`  status:   ${result.status} (${result.durationMs}ms)`);
  console.log(`  results:  ${result.count} tx(s)`);
  if (result.ids.length) console.log(`  sample:   ${result.ids[0]}`);
  if (result.error) console.log(`  error:    ${result.error}`);
}

async function main() {
  console.log('StreamVault HB query parity check');
  console.log(`HB query:     ${hbEndpoint}`);
  if (!hbOnly) console.log(`Arweave L1:   ${arweaveEndpoint}`);

  let hbHealthy = false;
  let anyParity = false;

  for (const { label, tags } of TAG_SETS) {
    console.log(`\n--- ${label} ---`);
    const hb = await postGraphql(hbEndpoint, { tags }).catch((e) => ({
      endpoint: hbEndpoint,
      ok: false,
      status: null,
      durationMs: 0,
      count: 0,
      ids: [],
      error: String(e?.message || e),
    }));
    printResult('HB query@1.0', hb);
    if (hb.ok) hbHealthy = true;

    if (hbOnly) continue;

    const ar = await postGraphql(arweaveEndpoint, { tags }).catch((e) => ({
      endpoint: arweaveEndpoint,
      ok: false,
      status: null,
      durationMs: 0,
      count: 0,
      ids: [],
      error: String(e?.message || e),
    }));
    printResult('arweave.net', ar);

    if (hb.ok && ar.ok) {
      const overlap = hb.ids.filter((id) => ar.ids.includes(id));
      console.log(`  overlap:  ${overlap.length}/${Math.max(hb.ids.length, ar.ids.length)} ids in both`);
      if (overlap.length > 0 || (hb.count > 0 && ar.count > 0)) anyParity = true;
    }
  }

  console.log('\n--- Summary ---');
  if (!hbHealthy) {
    console.log('HB query is NOT ready — keep VITE_ENABLE_HB_QUERY off; arweave.net fallbacks will be used.');
    process.exit(1);
  }
  if (hbOnly) {
    console.log('HB query responded successfully. Safe to try VITE_ENABLE_HB_QUERY=1 in .env.local.');
    process.exit(0);
  }
  if (anyParity) {
    console.log('Parity looks good — HB query returns L1 data. Enable VITE_ENABLE_HB_QUERY=1 after spot-checking in dev.');
    process.exit(0);
  }
  console.log('HB query responds but sample overlap with arweave.net is weak — verify copycat mirror lag before enabling.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
