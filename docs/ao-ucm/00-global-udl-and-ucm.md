# 0. Global UDL & UCM

This document clarifies how the **global** Universal Data License (UDL) and the **global** Universal Content Marketplace (UCM) relate to StreamVault’s protocol. We use the former as the license spec and the latter for trading; we only deploy or adopt our own AO processes where the global stack does not cover our needs.

## UDL — global license spec

The **Universal Data License (UDL)** is the canonical specification for licensing media on the permaweb. It is not an AO process we deploy; it is a legal and tag standard we align to.

- **Reference:** [udl.md](udl.md) (UDL Version 0.2).
- **Role:** Defines license parameters (Access, Derivation, Commercial Use, Data Model Training, Currency, Payment-Address, Payment-Mode, etc.) and how they are expressed as tags on the Network.
- **What we do:** We mint atomic assets with tags that follow or map to these parameters so that gateways, indexers, and other apps can interpret licensing consistently.

## UCM — global marketplace for trading

The **Universal Content Marketplace (UCM)** is an AO process that enables trustless exchange of atomic assets. It is deployed and maintained by the ecosystem, not by StreamVault.

- **Repository:** [permaweb/ao-ucm](https://github.com/permaweb/ao-ucm).
- **Role:** Orderbook for atomic assets: users create orders (market or limit) with tags such as `X-Order-Action: Create-Order`, `X-Base-Token`, `X-Quote-Token`, `X-Dominant-Token`, `X-Swap-Token`, `X-Group-ID`, and optional `X-Price`. Orders are matched; tokens swap between parties (minus fees).
- **What we do:** We plug in as users. We do **not** deploy our own orderbook; we list and sell music atomic assets on the global UCM when we want a marketplace experience.

## When we use global vs our own processes

| Need | Use global? | Notes |
|------|--------------|--------|
| **License terms & tags** | Yes | UDL ([udl.md](udl.md)) is the spec. We align our tag schema to it (see [02-data-model-and-udl-tags.md](02-data-model-and-udl-tags.md)). |
| **Trading / orderbook** | Yes | Global UCM (ao-ucm). We do not deploy an orderbook (see [07-streamvault-integration-notes.md](07-streamvault-integration-notes.md#listing-on-ucm)). |
| **Discovery** | Optional | UCM indexes for trading, not for “search by creator / license / AI-use.” For that we either deploy **MusicRegistry** ([05-ao-registry-and-search.md](05-ao-registry-and-search.md)) or use a public indexer/GraphQL. |
| **License workflow** | Optional | We can deploy **LicenseEngine** or integrate a standard UDL payment flow (e.g. permaweb/payments). Documented in [03-ao-process-architecture.md](03-ao-process-architecture.md) and [07-streamvault-integration-notes.md](07-streamvault-integration-notes.md). |
| **Royalty splits & payout** | Our process (or equivalent) | UCM does not accrue or split royalties. We use **RoyaltyEngine** ([06-royalty-engine-and-settlement.md](06-royalty-engine-and-settlement.md)) for programmable splits and GetPayoutPlan-style settlement, or another system that provides the same. |

## Summary

- **We do not deploy a “UDL process.”** UDL is a spec; we follow it in tags and metadata.
- **We use the global UCM** for listing and selling music atomic assets; we do not deploy our own orderbook.
- **We may still deploy (or adopt) our own process(es)** for discovery (MusicRegistry or external indexer), license workflow (LicenseEngine or standard payments), and royalty splits (RoyaltyEngine or equivalent).

The rest of this series ([01](01-overview.md) through [07](07-streamvault-integration-notes.md)) details our data model, AO architecture, upload flow, registry, royalty engine, and StreamVault integration.
