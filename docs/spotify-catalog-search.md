# Spotify catalog search (no user OAuth)

StreamVault uses Spotify’s **Client Credentials** flow on the **server only** (`SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`). The browser calls same-origin `GET /api/spotify-search?q=…` and never sees the client secret.

There is **no Spotify user login**, no PKCE, and no Premium requirement on the **app owner’s personal Spotify account** for this flow. Client Credentials grants access to **public catalog** endpoints (including search), not private user libraries.

## Spotify Developer Dashboard

1. Create an app at [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Note **Client ID** and **Client Secret** (reset secret if needed).

## Environment variables

| Variable | Where |
|----------|--------|
| `SPOTIFY_CLIENT_ID` | Vercel project env, or `.env.local` for local dev |
| `SPOTIFY_CLIENT_SECRET` | Same (never `VITE_*`) |

Optional: `SPOTIFY_CORS_ORIGIN` on the serverless function if you need to allow a non–same-origin web app to call the API (set to your frontend origin).

## Production (Vercel)

1. Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` under **Project → Settings → Environment Variables**.
2. Deploy. The function lives at `api/spotify-search.ts` → `/api/spotify-search`.

Static-only hosts (e.g. uploading `dist/` to Arweave without a backend) **do not** run this API; catalog search needs a deployment that serves `/api/spotify-search`.

## Local development

1. Put `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env.local` (see `.env.example`).
2. Terminal A: `npm run spotify:dev-api` — listens on `http://127.0.0.1:8787` and serves `/api/spotify-search`.
3. Terminal B: `npm run dev` — Vite proxies `/api/spotify-search` to that server.

Alternatively, run **`vercel dev`** from the repo root (serves Vite + serverless together) if you have the Vercel CLI linked; then you can skip the dev helper and proxy.

## Query parameters

- **`q`** (required) — search string.
- **`type`** (optional) — Spotify search `type` parameter; default `track`. Example: `track,artist,album`.

## Legacy OAuth docs

User OAuth, ngrok redirect URIs, and saved-track import lived in `docs/spotify-local-ngrok.md` and have been removed in favor of this catalog-only approach.
