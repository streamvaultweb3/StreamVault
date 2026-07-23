# @streamvault/sdk

Read-only SDK for StreamVault profiles, Arweave music uploads, AO atomic assets, and UCM marketplace context.

This package is an alpha release. The reliable first release surface supports profile lookup by Arweave wallet address or profile zone process id, then returns playable music tracks from wallet uploads and profile-zone atomic assets.

## Install

```bash
npm install @streamvault/sdk@alpha @permaweb/libs @permaweb/aoconnect arweave
```

npm package page: https://www.npmjs.com/package/@streamvault/sdk

## Quick Start

```ts
import Arweave from 'arweave';
import Permaweb from '@permaweb/libs';
import { connect } from '@permaweb/aoconnect';
import { createStreamVaultClient } from '@streamvault/sdk';

const ao = connect({ MODE: 'mainnet' });
const permaweb = Permaweb.init({
  ao,
  arweave: Arweave.init({}),
  gateway: 'https://ao-search-gateway.goldsky.com',
});

const streamvault = createStreamVaultClient({ permaweb });
const result = await streamvault.resolveProfile(walletOrProfileId);
const tracks = result.profile
  ? await streamvault.getTracksByProfile(result.profile, { limit: 50 })
  : [];

for (const track of tracks) {
  console.log(track.title, track.streamUrl, track.assetId);
}
```

## Core API

### `createStreamVaultClient(options)`

Creates the SDK client.

```ts
const streamvault = createStreamVaultClient({ permaweb });
```

Options:

- `permaweb`: permaweb-libs instance. Required for profile reads.
- `gqlUrl`: optional Arweave L1 GraphQL endpoint override.
- `aoGatewayUrl`: optional AO GraphQL gateway override.
- `hbReadNodes`: optional HyperBEAM read node list.
- `ario`: optional ARIO-compatible resolver for future ArNS support.

### Profile Methods

- `resolveProfile(ref)`: resolves an Arweave wallet address or profile zone id.
- `getProfileByWallet(walletAddress)`: loads the newest profile zone for a wallet.
- `getProfileById(profileId)`: loads a profile zone directly.

Handle and ArNS lookup are planned for a later release once StreamVault publishes a dedicated public handle index.

### Music Methods

- `getTracksByProfile(profile, { limit })`: loads wallet uploads and profile-zone music atomic assets.
- `getTracksByWallet(walletAddress, { limit })`: loads StreamVault Arweave uploads owned by a wallet.
- `getTrendingTracks({ limit })`: loads recent public StreamVault music uploads.
- `getStreamUrls(audioTxId)`: returns public Arweave gateway URLs for playback.
- `getPreferredStreamUrl(audioTxId)`: returns the default playback URL.

### Atomic Asset Methods

- `getAtomicAsset(assetId)`: resolves an AO atomic asset to its audio tx id and display metadata.
- `getAssetUcmMarketStatus(assetId)`: returns UCM marketplace status shape.
- `getAssetUcmAsks(assetId)`: returns current readable ask orders when indexed.
- `getMarketplaceListings({ limit })`: reserved for broader marketplace discovery.

## Using Returned Data

Partner apps can render players, track cards, playlist rows, or competition entries directly from `StreamVaultTrack`.

```ts
const result = await streamvault.resolveProfile(walletOrProfileId);
const tracks = result.profile
  ? await streamvault.getTracksByProfile(result.profile, { limit: 50 })
  : await streamvault.getTracksByWallet(walletOrProfileId, { limit: 50 });

for (const track of tracks) {
  console.log({
    title: track.title,
    artist: track.artist,
    audioTxId: track.audioTxId,
    audioUrl: track.streamUrl,
    coverArtUrl: track.artworkUrl,
    atomicAssetId: track.assetId,
  });
}
```

Field usage:

- `track.audioTxId`: permanent Arweave transaction id for the uploaded audio.
- `track.streamUrl`: default playable gateway URL for an audio element.
- `track.streamUrls`: fallback gateway URLs if a partner wants retry logic.
- `track.artworkUrl`: cover art URL for cards, players, and playlist rows.
- `track.assetId`: AO atomic asset id for license context, ownership, or UCM lookups.
- `track.title` and `track.artist`: normalized display metadata.
- `profile.displayName`, `profile.handle`, and `profile.avatarUrl`: profile UI metadata.

Gateway usage:

The SDK returns `track.streamUrl`, `track.streamUrls`, and `track.artworkUrl` so partners usually do not need to build URLs manually. If a partner wants to choose a gateway, append the Arweave transaction id to any compatible raw-data gateway URL.

```ts
const audioUrl = `https://arweave.net/${track.audioTxId}`;
const fallbackAudioUrl = `https://aoweave.tech/${track.audioTxId}`;
const coverArtUrl = track.artworkUrl;
```

## Types

- `StreamVaultProfile`: normalized profile id, wallet, display name, handle, media, and profile asset refs.
- `StreamVaultTrack`: playable track model with audio tx id, stream URLs, artwork, artist, and atomic asset id.
- `StreamVaultProfileResolution`: result from `resolveProfile`.
- `StreamVaultAtomicAsset`: atomic asset metadata and linked audio tx id.
- `AssetUcmMarketStatus`: UCM marketplace status shape for a music asset.

## Alpha Notes

- Public Arweave uploads are playable by anyone.
- UDL metadata describes usage terms but does not enforce playback restrictions.
- Handle and ArNS lookup are intentionally not part of the reliable alpha surface yet.
- UCM marketplace status is present as a stable type, but deeper listing discovery will expand after the first alpha.
