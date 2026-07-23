# StreamVault SDK

`@streamvault/sdk` is the read-only SDK for partner apps that need StreamVault profile music, playable Arweave URLs, AO atomic asset ids, and UCM marketplace context.

Current npm release:

```bash
npm install @streamvault/sdk@alpha @permaweb/libs @permaweb/aoconnect arweave
```

Published package: `@streamvault/sdk@0.0.1-alpha.2`

npm package page: https://www.npmjs.com/package/@streamvault/sdk

## What Partners Can Build

Competition platforms, playlist apps, and discovery clients can:

1. Accept an Arweave wallet address or StreamVault/Bazar profile zone id.
2. Resolve the public profile.
3. Load playable music tracks from wallet uploads and profile-zone music atomic assets.
4. Use `track.streamUrl` for playback.
5. Use `track.assetId` for AO atomic asset or UCM marketplace context.

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
  console.log({
    title: track.title,
    artist: track.artist,
    streamUrl: track.streamUrl,
    assetId: track.assetId,
  });
}
```

## Client

### `createStreamVaultClient(options)`

Creates the read-only SDK client.

Options:

- `permaweb`: permaweb-libs instance for profile-zone reads.
- `gqlUrl`: optional Arweave L1 GraphQL endpoint override.
- `aoGatewayUrl`: optional AO GraphQL gateway override.
- `hbReadNodes`: optional HyperBEAM read nodes for AO atomic asset metadata.
- `ario`: optional ARIO-compatible resolver reserved for future ArNS support.

## Profile API

- `resolveProfile(ref)`: accepts an Arweave wallet address or profile zone process id.
- `getProfileByWallet(walletAddress)`: loads the profile for a wallet.
- `getProfileById(profileId)`: loads a profile zone directly.

Return type: `StreamVaultProfile`

Fields include `id`, `walletAddress`, `displayName`, `handle`, `bio`, `avatarUrl`, `bannerUrl`, `assets`, and `raw`.

## Music API

- `getTracksByProfile(profile, { limit })`: loads wallet uploads and music atomic assets referenced by the profile zone.
- `getTracksByWallet(walletAddress, { limit })`: loads public StreamVault uploads owned by a wallet.
- `getTrendingTracks({ limit })`: loads recent public StreamVault music uploads.
- `getStreamUrls(audioTxId)`: returns public playback gateway URLs.
- `getPreferredStreamUrl(audioTxId)`: returns the default playback URL.

Return type: `StreamVaultTrack`

Fields include `id`, `audioTxId`, `title`, `artist`, `streamUrl`, `streamUrls`, `artworkUrl`, `assetId`, and `isPermanent`.

## Using Returned Data

Partner apps can render players, track cards, playlist rows, or competition entries directly from `StreamVaultTrack`.

```ts
const result = await streamvault.resolveProfile(walletOrProfileId);
const tracks = result.profile
  ? await streamvault.getTracksByProfile(result.profile, { limit: 50 })
  : await streamvault.getTracksByWallet(walletOrProfileId, { limit: 50 });

for (const track of tracks) {
  const audioTxId = track.audioTxId;
  const audioUrl = track.streamUrl;
  const coverArtUrl = track.artworkUrl;
  const atomicAssetId = track.assetId;

  console.log({
    title: track.title,
    artist: track.artist,
    audioTxId,
    audioUrl,
    coverArtUrl,
    atomicAssetId,
  });
}
```

Field usage:

- `track.audioTxId`: permanent Arweave transaction id for the uploaded audio.
- `track.streamUrl`: default playable gateway URL for an audio element.
- `track.streamUrls`: fallback gateway URLs if a partner wants retry logic.
- `track.artworkUrl`: cover art URL for cards, players, and playlist rows.
- `track.assetId`: AO atomic asset id for license context, ownership, or UCM lookups.
- `track.title` and `track.artist`: display metadata normalized from StreamVault upload tags or atomic asset state.
- `profile.displayName`, `profile.handle`, and `profile.avatarUrl`: profile UI metadata.

Gateway usage:

The SDK returns `track.streamUrl`, `track.streamUrls`, and `track.artworkUrl` so partners usually do not need to build URLs manually. If a partner wants to choose a gateway, append the Arweave transaction id to any compatible raw-data gateway URL.

```ts
const audioUrl = `https://arweave.net/${track.audioTxId}`;
const fallbackAudioUrl = `https://aoweave.tech/${track.audioTxId}`;
const coverArtUrl = track.artworkUrl;
```

Example player mapping:

```tsx
<article>
  <img src={track.artworkUrl} alt={track.title} />
  <h3>{track.title}</h3>
  <p>{track.artist}</p>
  <audio controls src={track.streamUrl} />
  <a href={`https://arweave.net/${track.audioTxId}`}>Audio on Arweave</a>
</article>
```

## Marketplace API

- `getAtomicAsset(assetId)`: resolves AO atomic asset metadata and linked audio tx id.
- `getAssetUcmMarketStatus(assetId)`: returns the UCM market status shape.
- `getAssetUcmAsks(assetId)`: returns readable asks when indexed.
- `getMarketplaceListings({ limit })`: reserved for broader listing discovery.

## Alpha Limits

Handle and ArNS lookup are not part of the reliable alpha surface yet. They need a dedicated public StreamVault handle index so partners are not forced to scan profile-zone state.

Public Arweave uploads are playable by anyone. UDL metadata describes rights and terms, but does not restrict playback by itself. Private paid playback will need encrypted uploads and key-grant logic on top of the public metadata.
