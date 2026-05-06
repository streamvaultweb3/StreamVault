# Spotify OAuth: local dev with ngrok

Spotify requires **HTTPS** redirect URIs for production-like apps. For local testing, expose Vite (`5173`) with ngrok and register that URL in the Spotify Developer Dashboard.

## 1. Tunnel Vite

```bash
ngrok http 5173
```

Copy the **HTTPS** forwarding URL (for example `https://abc123.ngrok-free.dev`). Free ngrok often uses the `*.ngrok-free.dev` host.

## 2. Spotify Developer Dashboard

1. Open [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → your app.
2. **Redirect URIs**: add exactly:

   `https://<your-ngrok-subdomain>.ngrok-free.dev/spotify/callback`

   No trailing slash unless you also use one in the app. Path must be `/spotify/callback` (the app serves this path, then rewrites to the hash route).

3. **Development mode**: under **Users**, add the Spotify account(s) you will log in with. Otherwise `/v1/me` can return **403** for accounts not on the allowlist.

## 3. `.env.local`

Create or edit `.env.local` in the project root (do **not** commit secrets; client secret is not used in the browser):

```env
VITE_SPOTIFY_CLIENT_ID=your_client_id_here
# Optional but recommended when using ngrok so authorize + token exchange use the same URI:
VITE_SPOTIFY_REDIRECT_URI=https://<your-ngrok-subdomain>.ngrok-free.dev/spotify/callback
# Optional: comma or space separated; defaults include user-read-private user-read-email user-library-read
# VITE_SPOTIFY_SCOPES=user-read-private user-read-email user-library-read
# Optional: log token/API bodies in the browser console
# VITE_DEBUG_SPOTIFY=1
```

Restart `npm run dev` after changing env vars.

## 4. Open the app on the tunnel origin

**Important:** PKCE verifier and OAuth state live in **browser storage keyed by origin**. Start the connect flow from the **same origin** Spotify will redirect to.

- Browse to `https://<subdomain>.ngrok-free.dev/` (and use the hash routes as usual), **not** `http://localhost:5173`, when using an ngrok redirect URI.
- If you use `VITE_SPOTIFY_REDIRECT_URI` with the ngrok URL, still open the UI via that ngrok URL so session/local storage matches the callback.

## 5. If something goes wrong

1. **Clear site data** for the ngrok origin (or use a fresh **incognito** window), especially after changing redirect URIs or client ID.
2. **Multiple Spotify accounts:** use incognito or sign out at [spotify.com](https://www.spotify.com) so you authorize the intended account.
3. **`redirect_uri` mismatch:** the value in the dashboard, in `VITE_SPOTIFY_REDIRECT_URI` (if set), and the URL Spotify redirects to must match **exactly** (scheme, host, path, no fragment).
4. **403 on `/v1/me`:** add your user under **Users** in the app settings (Development mode), confirm scopes include `user-read-private`, and set `VITE_DEBUG_SPOTIFY=1` to inspect API error JSON in the console.

## Checklist

- [ ] `ngrok http 5173` running; HTTPS URL noted  
- [ ] Redirect URI in dashboard = `https://<subdomain>.ngrok-free.dev/spotify/callback`  
- [ ] `VITE_SPOTIFY_CLIENT_ID` set; dev server restarted  
- [ ] Optional: `VITE_SPOTIFY_REDIRECT_URI` matches dashboard exactly  
- [ ] App opened at ngrok HTTPS origin before clicking **Connect Spotify**  
- [ ] Test Spotify user added under app **Users** (Development mode)  
- [ ] Storage cleared or incognito if retrying after errors  
