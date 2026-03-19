# AO-UDL Music Protocol — Overview

This series of documents captures the design of a **UDL‑compliant music protocol** for StreamVault, built on **Arweave**, **AO**, and **@permaweb/libs**. How StreamVault relates to the **global** UDL spec and the **global** Universal Content Marketplace (UCM) is described in [00-global-udl-and-ucm.md](00-global-udl-and-ucm.md): we use the global UDL as the license reference and plug into the global UCM for trading; we only deploy or use our own AO processes for discovery, license workflow, and royalty splits where needed.

Goals:

- Store all music and metadata as **atomic assets** on Arweave.
- Attach **Universal Data License (UDL)** information via tags and metadata, including AI‑use permissions.
- Use **AO processes** for discovery, licensing, and royalty accounting (message‑passing instead of L1 smart contracts).
- Let artists mint tracks with programmable revenue splits and support **multi‑chain payouts** (e.g. $U, MATIC).
- Integrate seamlessly into the existing StreamVault app (Audius discovery + Arweave publishing).

This overview is materialized in:

- `00-global-udl-and-ucm.md` — global UDL spec and UCM; when we use them vs our own processes.
- `02-data-model-and-udl-tags.md` — core atomic asset shape and tag schema.
- `03-ao-process-architecture.md` — MusicRegistry, LicenseEngine, RoyaltyEngine.
- `04-upload-with-udl.md` — Bundlr + @permaweb/libs upload and mint example.
- `05-ao-registry-and-search.md` — AO Lua + TS helper for track registration and discovery.
- `06-royalty-engine-and-settlement.md` — AO royalty accounting and payout scripts.
- `07-streamvault-integration-notes.md` — how this protocol is wired into the StreamVault UI and publish flow.

