/**
 * Local dev server mirroring api/spotify-search.ts for Vite proxy (port 8787).
 * Loads SPOTIFY_* from process.env or project-root .env.local (KEY=value lines).
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envPath = join(root, '.env.local');

function loadEnvLocal() {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvLocal();

const ACCOUNTS_TOKEN = 'https://accounts.spotify.com/api/token';
const SEARCH = 'https://api.spotify.com/v1/search';

let tokenCache = null;

function getBasicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

async function getClientCredentialsToken(clientId, clientSecret) {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 15_000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch(ACCOUNTS_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: getBasicAuthHeader(clientId, clientSecret),
    },
    body,
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(raw.trim() || `Spotify token HTTP ${res.status}`);
  }

  const json = JSON.parse(raw);
  if (!json.access_token) {
    throw new Error('Spotify token response missing access_token');
  }

  const ttlSec = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  tokenCache = {
    accessToken: json.access_token,
    expiresAtMs: now + Math.max(60, ttlSec - 30) * 1000,
  };
  return tokenCache.accessToken;
}

const PORT = Number(process.env.SPOTIFY_DEV_API_PORT || 8787);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname !== '/api/spotify-search') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const clientId = (process.env.SPOTIFY_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local' }));
    return;
  }

  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing query parameter q' }));
    return;
  }

  const type = (url.searchParams.get('type') || 'track').trim() || 'track';

  try {
    const accessToken = await getClientCredentialsToken(clientId, clientSecret);
    const params = new URLSearchParams({ q, type, limit: '20' });
    const spotifyRes = await fetch(`${SEARCH}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const bodyText = await spotifyRes.text();
    res.writeHead(spotifyRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(bodyText);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Spotify search failed';
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[spotify-search-dev] http://127.0.0.1:${PORT}/api/spotify-search`);
});
