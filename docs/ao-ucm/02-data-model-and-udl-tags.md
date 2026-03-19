# 1. Data Model & UDL Tag Schema

## Atomic asset shape

All tracks are minted as **atomic assets** using `@permaweb/libs.createAtomicAsset` with this canonical shape:

- `name`: track title.
- `description`: human‑readable description.
- `topics`: e.g. `["Music", "StreamVault", "Track"]`.
- `creator`: artist wallet or profile id.
- `data`: canonical audio URL, e.g. `https://arweave.net/<audioTxId>`.
- `contentType`: `audio/mpeg` or `audio/wav`.
- `assetType`: e.g. `"music-track"`.
- `metadata`:
  - `audioTxId`, `coverTxId`.
  - `durationSeconds`, `bpm`, `genre`, `mood`.
  - `royaltiesBps` (e.g. `1000` = 10%).
  - `splits`: array of `{ address, shareBps, chain, token }`.
  - `udl`: `{ licenseId, uri, usage, aiUse, fee, currency, interval, jurisdiction }`.

## UDL tag schema

The same license information is also surfaced via **Arweave tags** on the audio and/or atomic asset transactions:

- `License`: license template, e.g. `udl://music/1.0`.
- `License-URI`: `ar://` id or HTTP URL of the full UDL text.
- `License-Use`: comma‑separated usages, e.g. `stream,download,commercial-sync,remix`.
- `License-AI-Use`: `allow-train` \| `allow-generate` \| `deny`.
- `License-Fee`: numeric string fee, e.g. `'0'`, `'1'`, `'5'`.
- `License-Fee-Unit`: `one-time` \| `per-stream` \| `per-download` \| `per-month`.
- `License-Currency`: e.g. `U`, `MATIC`, `USDC.base`, `AR`.
- `License-Attribution`: `required` \| `optional`.
- `License-Revshare-Bps`: total creator revshare basis points if distinct from `royaltiesBps`.

## UDL tag mapping (StreamVault ↔ UDL v0.2)

For ecosystem compatibility (gateways, indexers, other UDL-aware apps), our tag names can be mapped to the official **UDL v0.2** parameter names from [udl.md](udl.md) Section 3. Optionally we can emit **both** our names and the official names (dual-tagging).

| StreamVault tag | UDL v0.2 parameter | Notes |
|-----------------|-------------------|--------|
| `License` | — | License identifier; UDL defines parameters, not a single “License” tag. |
| `License-URI` | — | Pointer to full license text (ar:// or HTTP). |
| `License-Use` | `Derivation`, `Commercial-Use` | Our usage presets (e.g. stream, download, commercial-sync) map to Derivation and/or Commercial-Use values (e.g. Allowed, Allowed-With-Credit). |
| `License-AI-Use` | `Data-Model-Training` | `allow-train` → Allowed; `allow-generate` → Allowed; `deny` or absent → not allowed. Fee variants map to Allowed-With-Fee-One-Time-[n] or Allowed-With-Fee-Monthly-[n]. |
| `License-Fee` | `Access-Fee` (and fee parts of Derivation/Commercial-Use/Data-Model-Training) | UDL uses e.g. One-Time-[.0-9+] or recurring; we use numeric string + unit. |
| `License-Fee-Unit` | Interval in fee parameters | one-time, per-month, etc. UDL encodes in value (e.g. One-Time-5, Allowed-With-Fee-Monthly-1). |
| `License-Currency` | `Currency` | Same intent; default in UDL is $U on Arweave. |
| `License-Attribution` | Credit (Section 8) | required/optional attribution; UDL expresses via Allowed-With-Credit in Derivation/Commercial-Use. |
| — | `Payment-Address` | We do not currently emit; add for full UDL compatibility (address to receive license/access fees). |
| — | `Payment-Mode` | We do not currently emit; UDL values: Random-Distribution, Global-Distribution (for multiple Payment Addresses). |

Dual-tagging: when targeting broad UDL compatibility, emit both our tags and the official UDL parameter tags (e.g. `Currency`, `Data-Model-Training`, `Access-Fee` with UDL-style values) on the same transaction.

## Discovery tags

For GraphQL‑based discovery:

- `App-Name: StreamVault`
- `Content-Type: audio/mpeg`
- `Track-Id`: atomic asset id.
- `Artist-Address`, `Artist-Handle`
- `Genre`, `Mood`, `BPM`
- `Network`: `arweave`, `polygon`, `base`, etc.

