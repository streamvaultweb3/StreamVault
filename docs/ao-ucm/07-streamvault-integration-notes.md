# 6. StreamVault Integration Notes

This document summarizes how the UDL music protocol is integrated into the **StreamVault** app.

## Publish flow

- **Sample tier (< 100 KiB)**:
  - Uses a direct Arweave data transaction signed by Wander.
  - Adds basic tags (`App-Name`, `Type: audio-sample`, `Title`, `Artist`, `Duration-Seconds`).
  - Resulting permaweb URL is shown as a collectible preview in the UI and can be attached to the creator profile via @permaweb/libs Zones.

- **Full tier (atomic asset)**:
  - Audio is uploaded via **Turbo Credits** or a direct data tx depending on user choice.
  - Tags include both protocol metadata and UDL tags (`License`, `License-Use`, `License-AI-Use`, etc.).
  - `publishFullAsAtomicAsset`:
    - Creates an atomic asset with `metadata.audioTxId`, `metadata.udl`, and `metadata.splits`.
    - Stores artwork either from Audius or an uploaded/generator image.
    - Calls an AO helper (`registerTrackOnAO`) to register the new track in `MusicRegistry`.

## UI wiring

- **Publish modal**:
  - Lets creators choose between **Sample — Free** and **Full — Atomic Asset** tiers.
  - Full tier includes:
    - File upload for full audio.
    - Optional cover image upload (or generated cover from the in‑browser Art Engine tools).
    - Royalties bps input.
    - UDL section: usage preset, AI‑use toggle, fee + currency selectors.
    - Turbo toggle and payment token selection (Arweave, Ethereum, Base, Solana, Polygon).

- **Wallets**:
  - **Arweave (Wander)** for signing Arweave data transactions and AO messages.
  - **EVM wallets** (MetaMask / Brave) for Turbo payments and off‑chain royalty settlement in MATIC/ETH.
  - **Solana wallets** (Phantom) for Turbo uploads funded with SOL if selected.

## AO processes

- Publish flow calls:
  - `MusicRegistry.RegisterTrack` after atomic asset mint.
  - (Future) `RoyaltyEngine.AccrueRoyalties` when paid uses are tracked in the player.
- Off‑chain tooling:
  - Royalty settlement scripts read AO balances (`GetPayoutPlan`) and execute payouts on Polygon or AO.

## Listing on UCM

StreamVault does **not** deploy its own orderbook. To list and sell music atomic assets on the marketplace, we plug into the **global Universal Content Marketplace (UCM)** — the AO process maintained by the ecosystem.

- **Reference:** [permaweb/ao-ucm](https://github.com/permaweb/ao-ucm). See also [00-global-udl-and-ucm.md](00-global-udl-and-ucm.md).
- **Mechanics:** Users send a **Transfer** message to the UCM process with tags that create an order. Required tags include:
  - `X-Order-Action`: `Create-Order`
  - `X-Base-Token`, `X-Quote-Token` (token identifiers for the trading pair)
  - `X-Base-Token-Denomination`, `X-Quote-Token-Denomination`
  - `X-Dominant-Token`, `X-Swap-Token`
  - `X-Group-ID`
- **Optional:** `X-Price` for limit orders (omit for market orders).
- **Integration:** Once the UCM process ID is known, the app can call it via `@permaweb/aoconnect` (message + signer + tags + data). Sellers deposit the atomic asset (or its token); buyers deposit the quote token; the UCM matches orders and settles.

## Documentation & future work

- README and in‑app copy emphasize:
  - **“Stream anywhere. Preserve forever.”**
  - Difference between streaming (Audius) and permanent publishing (Arweave).
  - UDL‑driven licensing, AI‑use policy, and revenue splits.
- Future extensions:
  - AO‑native $U royalty paths.
  - x402 just‑in‑time payments with Turbo.
  - Auto‑import of AO/Arweave data for creator dashboards.

