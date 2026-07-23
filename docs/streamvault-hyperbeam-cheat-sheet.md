# StreamVault × HyperBEAM Cheat Sheet

Quick reference for Portal HB, L1 vs AO layers, UCM listing, and env flags.

**Implementation map:** [.cursor/hyperbeam-integration.md](../.cursor/hyperbeam-integration.md)

## VPN / geo: reads vs writes (important)

| Concern | What fails | Fix in StreamVault |
|---------|------------|--------------------|
| **Tiles / media without VPN** | `arweave.net` CORS/429 + sandbox redirects; Discover GraphQL hangs | L1 GraphQL races `arweave-search.goldsky.com` first; media prefers `turbo-gateway.com` → `akrd.net` → `ardrive.net` (not sandbox hosts) |
| **Wander popup with VPN** | Portal HB dryruns hang ~4–30s before `signDataItem`, burning the browser **user-gesture** so the extension never opens | UCM **reads/dryruns** use **Bazar HB** (`app-1.forward.computer`); Init/Mint **skips Portal preflight** when Balances are already empty/inferred; signed **pushes** still prefer Portal via resilient fetch |

**Try this:** keep VPN **off** for day-to-day browsing (tiles should load via Turbo/Goldsky). Listings should open Wander without needing VPN for Portal. If Wander still does not pop, disable VPN only for the sign click — extension popups can still break under some VPNs.

## Two layers

| Layer | StreamVault uses |
|-------|------------------|
| **Arweave L1** | Turbo uploads, goldsky/arweave L1 GraphQL, turbo-first `/{txId}` media |
| **AO / HyperBEAM** | Portal HB writes (scheduler), Bazar HB reads, UCM orderbooks, atomic assets |

## Portal / Bazar defaults (production path)

Unset optional operator vars → behavior matches today’s production path:

- **Writes / spawn identity:** Portal — `VITE_AO_URL=https://hb.portalinto.com`
- **Push primary:** Portal — `VITE_AO_WRITE_URL` (defaults to Portal)
- **Scheduler / authority:** Portal triple  
  `VITE_AO_SCHEDULER=n_XZJhUnmldNFo4dhajoPZWhBXuJk-OcQr5JQ49c4Zo`  
  `VITE_AO_AUTHORITY=a5ZMUKbGClAsKzB4SHDYrwkOZZHIIfpbaxrmKwUHCe8`
- **Reads:** Bazar-first — `https://app-1.forward.computer` unless `VITE_AO_READ_URL` is set
- **Operator reads:** only when process spawn `Scheduler` matches `VITE_AO_OPERATOR_SCHEDULER` (not appended to every read)
- **Operator hydrate:** after writes, Portal schedules may be warmed onto `VITE_AO_OPERATOR_URL` in the background
- **Do not** commit `VITE_AO_URL` / WRITE / READ pointing at `arweave.nyc` until verified

## Optional operator node (`arweave.nyc`)

Personal / operator HyperBEAM is **opt-in**. One **URL + scheduler + authority** triple per node — never mix Portal’s scheduler with the `arweave.nyc` URL.

### 1. Capture the triple from your node

```bash
# From the machine that runs the node, or any client that can reach it:
curl -sS 'https://arweave.nyc/~meta@1.0/info' | jq .
```

Note:

- Public URL (e.g. `https://arweave.nyc`)
- Scheduler id (must match spawn `Scheduler` tags for processes owned there)
- Authority id
- Wallet / `~faff@1.0` allow-list should include your StreamVault / Wander address if the node gates devices
- Prefer `scheduler@1.0` + `~process@1.0` loaded; local TX fetch on-node when available (HB moving off `arweave.net/raw` loops)

### 2. Wire in `.env.local` only (not committed defaults)

```bash
VITE_AO_OPERATOR_URL=https://arweave.nyc
VITE_AO_OPERATOR_SCHEDULER=<from ~meta@1.0/info>
VITE_AO_OPERATOR_AUTHORITY=<from ~meta@1.0/info>

# Optional while verifying:
VITE_DEBUG_AO=1
```

Restart `npm run dev`. With `VITE_DEBUG_AO=1`, console `[ao] init` shows `operatorNode` + `readNodes` / `writeNodes`. Operator is preferred for HB **reads** only when a process’s spawn `Scheduler` tag matches `VITE_AO_OPERATOR_SCHEDULER`. It is **not** probed for Portal-scheduled assets (avoids nyc `500 case_clause` spam). After writes, hydration may still warm the process onto the operator in the background. Portal/Bazar remain the read path for Portal schedules. Writes stay Portal-first unless you later change WRITE env vars after verifying.

### 3. Verify before flipping defaults

1. Spawn or list a test asset whose spawn tags use your operator scheduler.
2. Network tab / `VITE_DEBUG_HB=1`: asset + orderbook reads should hit `arweave.nyc` first for that process.
3. Confirm Init/Mint credits Balances on that node; List either shows **Ask live** or explicit **Escrowed, ask not readable** (never silent soft-success).
4. Confirm Portal/Bazar fallbacks still work when the operator node lags.
5. Only after that, consider pointing `VITE_AO_URL` / WRITE / READ at `arweave.nyc` (still local `.env`, not committed until the team agrees).

## HB query (copycat + query@1.0)

```bash
# When Portal copycat is live (verify first):
npm run diag:hb-query
# Then in .env.local:
VITE_ENABLE_HB_QUERY=1
```

Falls back to arweave.net / goldsky automatically when HB query returns errors.

## UCM listing flow

1. Warm Wander permissions on List click (preserve user gesture)
2. If Balances empty / inferred → **Init/Mint** (no Portal dryrun wait)
3. **Hard gate:** Transfer is blocked until Balances show a real wallet credit (not tag-inferred only)
4. Resolve **dedicated per-asset orderbook** (cached in `localStorage`)
5. **Wallet-direct** `createOrder` when creator holds copies on wallet
6. Wander signs `Transfer` / `Run-Action`; push retries Portal then Bazar (operator last when configured)
7. Orderbook / asset hydrate prefers **scheduler-matching** HB URL first
8. **Hard gate success:** UI reports **Ask live** only when ask is readable; otherwise **Escrowed, ask not readable** or unconfirmed (never claim Listed on inference)

**Common stall:** HB shows `Balances: []` but creator inference finds copies — listing must Init/Mint and wait for credit before Transfer.

**Escrowed-unread stall:** Asset Credit-Notice shows Success on Lunar but orderbook `Orders`/`Asks` stay empty. Often HB delivers tags lowercased (`x-order-action`) while UCM reads Title-Case — Create-Order is skipped. StreamVault listing uses sync `/push?max-depth=5` first, then auto-runs an owner Eval that normalizes tags and replays stuck Create-Order Credit-Notices. Repair button does the same. Stuck escrowed copies do **not** return to the wallet automatically.

## Key files

| File | Role |
|------|------|
| `src/lib/aoNode.ts` | Node registry (Portal / Bazar / optional operator) + read vs write URL order |
| `src/lib/hbScheduler.ts` | Process spawn Scheduler → preferred HB URL(s) |
| `src/lib/hbNode.ts` | Scheduler-aware HyperBEAM JSON reads |
| `src/lib/ucm.ts` | List/cancel, Init/Mint hard gate, ask confirm |
| `src/lib/ucmOrderbookRead.ts` | Dedicated orderbook Info / ask extract (not Portal-pinned) |
| `src/lib/aoFetch.ts` | Resilient push + 307 provenance-preserving follow |
| `src/lib/arweaveDataGateway.ts` | Turbo-first media + L1 GraphQL race |
| `src/components/ListOnUcm.tsx` | List on UCM UI (honest ask / escrow outcomes) |
| `tools/hb-query-parity.mjs` | HB query vs arweave.net check |
