#!/usr/bin/env node

/**
 * AO/HyperBEAM diagnostics:
 * - Node metadata reachability
 * - Process endpoint status (/init, /slot/current, /now)
 * - Action=Info status
 *
 * Usage:
 *   npm run diag:ao -- --node http://localhost:8734 --process <id> --process <id2>
 *   npm run diag:ao -- --node http://localhost:8734 --fallback https://tee-6.forward.computer --process <id>
 */

const DEFAULT_NODE = process.env.VITE_AO_URL || "http://localhost:8734";
const DEFAULT_FALLBACK = process.env.VITE_AO_READ_URL || "https://tee-6.forward.computer";

function parseArgs(argv) {
  const out = {
    node: DEFAULT_NODE,
    fallback: DEFAULT_FALLBACK,
    processes: [],
    timeoutMs: 8000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--node" && argv[i + 1]) out.node = argv[++i];
    else if (arg === "--fallback" && argv[i + 1]) out.fallback = argv[++i];
    else if (arg === "--process" && argv[i + 1]) out.processes.push(argv[++i]);
    else if (arg === "--timeout" && argv[i + 1]) out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
  }
  return out;
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function printResult(label, result) {
  const preview = (result.text || "").slice(0, 180).replace(/\s+/g, " ").trim();
  console.log(`${label}: status=${result.status} ok=${result.ok} body="${preview}"`);
}

async function checkNode(nodeBase, processIds, timeoutMs) {
  console.log(`\n=== Node: ${nodeBase} ===`);

  const meta = await fetchWithTimeout(`${nodeBase}/~meta@1.0/info/address`, { method: "GET" }, timeoutMs);
  printResult("meta.address", meta);

  for (const processId of processIds) {
    const initUrl = `${nodeBase}/${processId}~process@1.0/init`;
    const slotUrl = `${nodeBase}/${processId}~process@1.0/slot/current`;
    const nowUrl = `${nodeBase}/${processId}~process@1.0/now`;
    const infoUrl = `${nodeBase}/${processId}~process@1.0/as=execution/compute&Action=Info`;
    const jsonHeaders = { Accept: "application/json" };

    const initGet = await fetchWithTimeout(initUrl, { method: "GET", headers: jsonHeaders }, timeoutMs);
    printResult(`process ${processId} GET init`, initGet);

    const slotGet = await fetchWithTimeout(slotUrl, { method: "GET", headers: jsonHeaders }, timeoutMs);
    printResult(`process ${processId} GET slot/current`, slotGet);

    const nowGet = await fetchWithTimeout(nowUrl, { method: "GET", headers: jsonHeaders }, timeoutMs);
    printResult(`process ${processId} GET now`, nowGet);

    const infoPost = await fetchWithTimeout(
      infoUrl,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      },
      timeoutMs
    );
    printResult(`process ${processId} POST Action=Info`, infoPost);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const node = normalizeBase(args.node);
  const fallback = normalizeBase(args.fallback);
  const processIds = args.processes.filter(Boolean);

  if (processIds.length === 0) {
    console.error("No process ids provided. Pass one or more with --process <id>.");
    process.exit(1);
  }

  console.log("AO diagnostics config:");
  console.log(JSON.stringify({ node, fallback, timeoutMs: args.timeoutMs, processIds }, null, 2));

  await checkNode(node, processIds, args.timeoutMs);
  if (fallback && fallback !== node) {
    await checkNode(fallback, processIds, args.timeoutMs);
  }
}

main().catch((e) => {
  console.error("diag failed:", e);
  process.exit(1);
});
