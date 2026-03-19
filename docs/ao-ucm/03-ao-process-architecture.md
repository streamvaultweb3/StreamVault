# 2. AO Process Architecture

The protocol uses three primary AO processes that communicate via messages:

## MusicRegistry

Tracks registered after minting:

- **State**: `tracks` map keyed by `assetId`:
  - `{ assetId, audioTxId, creator, udl, splits, tags, createdAt }`.
- **Messages**:
  - `RegisterTrack` — called post‑mint; asserts `Creator` and stores the record.
  - `UpdateTrackMeta` — optional, for non‑license metadata patches.
  - `SearchTracks` — filter by `Creator`, `License`, `AIUse`, tags and return list.
- **Implementation**: Lua module using `Handlers.add`; JSON payloads; accessed from TS via `@permaweb/aoconnect`.

## LicenseEngine

Computes license quotes and tracks granted licenses:

- **State**: `quotes` map keyed by `quoteId` with `{ assetId, useCase, fee, currency, expiresAt }`.
- **Messages**:
  - `RequestLicense` — `{ assetId, useCase, payer }` → derives `fee`/`currency` from the asset’s `udl` and emits a quote.
  - `ConfirmPayment` — `{ quoteId, paymentTxId, amount, currency }` → performs sanity checks and records a `LicenseGrant`.
- **Usage**: clients call this to obtain an auditable license receipt before treating a payment as valid.

## RoyaltyEngine

Tracks balances per recipient and currency:

- **State**: `balances` map `{ chain, token, address } → amount`, plus optional per‑asset counters.
- **Messages**:
  - `RecordUsage` — log a paid usage event (optional indirection from LicenseEngine).
  - `AccrueRoyalties` — split a gross `amount` across `splits[]` in basis points and increment balances.
  - `GetPayoutPlan` — returns current balances; used by an off‑chain agent or client to send real payouts.

## Client flow (high level)

1. **Publish full track**
   - Upload audio via Turbo/Bundlr + tags.
   - Mint an atomic asset via `createAtomicAsset` with `metadata.udl` + `splits`.
   - Send `RegisterTrack` to `MusicRegistry`.
2. **License + pay**
   - User selects track and desired usage.
   - Call `RequestLicense` to get `{ fee, currency, quoteId }`.
   - User pays fee via an integrated wallet (Arweave, EVM, Solana).
   - Client calls `ConfirmPayment` → `AccrueRoyalties`.
3. **Payout**
   - Off‑chain script or service calls `GetPayoutPlan`, then executes on‑chain payouts in $U, MATIC, etc.

