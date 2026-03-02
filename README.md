# StreamVault

**Stream anywhere. Preserve forever.**

A next-generation decentralized music streaming app inspired by Apple Music’s clean, premium UI. It uses the **Open Audio Protocol (Audius)** for discovery and streaming, and **Arweave** for permanent publishing.

## Features

- **Discovery** — Home feed of trending tracks from Audius
- **Streaming** — Play tracks from the Open Audio Protocol
- **Artist profiles** — View artist pages and track lists
- **Now Playing** — Persistent player bar with progress
- **Publish to Arweave** (creator-only):
  - **Sample** — 15s preview under 100KB, free upload, permaweb link, collectible in-app
  - **Full** — Up to ~10MB as an **Atomic Asset** (permaweb-libs), with metadata, artwork, royalties-ready
- **Wallets** — Arweave (Wander), Ethereum (EVM), Solana
- **Shareable profile links** — `/profile/:address` for creators

## Tech stack

- **Vite** + **React 18** + **React Router** (HashRouter for perma-app)
- **Audius API** — `api.audius.co` for tracks and streaming
- **Arweave** — Data transactions for uploads; **@permaweb/libs** for atomic assets
- **@permaweb/aoconnect** — AO signer for atomic asset creation

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Build (perma-app ready)

```bash
npm run build
```

Output is in `dist/`. The app uses `base: './'` and **HashRouter** so it works when deployed to a static host or Arweave.

## Branch workflow & going live

- **`main`** — production; what's live. Deploy from here (e.g. Vercel production).
- **`develop`** — day-to-day development. Do your work here, then open a **Pull Request** into `main` when ready to release.
- **Flow:** branch off `develop` for features → merge to `develop` → PR `develop` → `main` → production updates.

## Deploy to Vercel

1. Push your repo to GitHub (e.g. `https://github.com/Jharmony/StreamVault`).
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → **Import** your GitHub repo.
3. Leave defaults (Vite is auto-detected; build: `npm run build`, output: `dist`). Or use the included `vercel.json`.
4. Add environment variables if needed (e.g. `VITE_AUDIUS_API_KEY`, `VITE_AO`) in **Project → Settings → Environment Variables**.
5. **Deploy**. Your site will be at `https://your-project.vercel.app`. Production deploys run on every push to `main` (or the branch you set as Production).

## Deploy to Arweave (perma-app)

1. Build: `npm run build`
2. Upload the `dist/` folder to Arweave:
   - **Using Permaweb skills** (from repo root):
     ```bash
     use arweave to upload ./dist
     ```
   - Or **upload-site** with wallet:
     ```bash
     node skills/arweave/index.mjs upload-site ./dist --wallet ./wallet.json
     ```
   - Or **arx** (Turbo):
     ```bash
     npx @permaweb/arx upload-dir ./dist --index-file index.html -t arweave -w ./wallet.json
     ```
3. Attach the returned transaction ID to an ArNS name if desired:
   ```bash
   use arweave to attach <txId> myname
   ```

## Environment

- `VITE_AUDIUS_APP_NAME` — Optional app name for Audius API
- `VITE_AO` — Optional AO mode (`legacy` | `mainnet`) for permaweb-libs

## Architecture notes

- **Free uploads under 100KB** — Sample tier uses a single Arweave data transaction (signed with Wander).
- **Turbo uploads for full assets** — When **Turbo** is enabled in the publish modal, full tracks are uploaded via `@ardrive/turbo-sdk/web` using **Turbo Credits**, then wrapped as atomic assets. Payment tokens supported in the UI today: `arweave`, `ethereum`, `base-eth`, `solana`.
- **Multi-wallet uploads** — Turbo is wired to work with multiple wallet types:
  - Arweave: Wander / ArConnect (Turbo `signer` via `ArconnectSigner`)
  - EVM (Ethereum + Base): browser wallets like MetaMask / Brave (Turbo `signer` via `InjectedEthereumSigner` over an `ethers` `BrowserProvider`)
  - Solana: Phantom-style injected wallet (Turbo `walletAdapter` for `token: 'solana'`)
- **Larger files** — Non-Turbo full tier uploads the file as a direct Arweave data tx (with size guard ~10MB) and then creates an atomic asset with metadata pointing to the file. Turbo removes this size constraint by using chunked uploads backed by Turbo Credits.
- **Atomic assets** — `libs.createAtomicAsset()` with `assetType: 'audio'`, metadata (e.g. `audioTxId`, `streamUrl`, `artwork`, `royaltiesBps`) for future DEX/royalty integration.
- **x402 & advanced Turbo features (roadmap)** — StreamVault’s use of `TurboFactory.authenticated()` and `uploadFile` is compatible with Turbo’s **x402 pay-per-upload**, **credit sharing**, and additional token rails (USDC on Base, ARIO, KYVE, etc). The current implementation focuses on the common flows (Turbo Credits + wallet payments); wiring in x402 funding modes and organizational credit sharing can be added with minimal changes in the `uploadWithTurbo` helper.
- **Creator verification** — “Publish to Arweave” is shown only when the connected wallet matches the track’s artist (Audius user id compared with connected address where applicable).

## License

MIT
