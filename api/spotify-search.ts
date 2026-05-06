import type { VercelRequest, VercelResponse } from '@vercel/node';

const ACCOUNTS_TOKEN = 'https://accounts.spotify.com/api/token';
const SEARCH = 'https://api.spotify.com/v1/search';

let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

function getBasicAuthHeader(clientId: string, clientSecret: string): string {
  const pair = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

async function getClientCredentialsToken(clientId: string, clientSecret: string): Promise<string> {
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

  const json = JSON.parse(raw) as { access_token?: string; expires_in?: number };
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

function firstQueryParam(v: string | string[] | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const origin = process.env.SPOTIFY_CORS_ORIGIN?.trim();
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    res.status(503).json({ error: 'Spotify server credentials are not configured.' });
    return;
  }

  const q = firstQueryParam(req.query?.q).trim();
  if (!q) {
    res.status(400).json({ error: 'Missing query parameter q' });
    return;
  }

  const typeRaw = firstQueryParam(req.query?.type).trim();
  const type = typeRaw || 'track';

  try {
    const accessToken = await getClientCredentialsToken(clientId, clientSecret);
    const params = new URLSearchParams({ q, type, limit: '20' });
    const spotifyRes = await fetch(`${SEARCH}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const bodyText = await spotifyRes.text();
    res.status(spotifyRes.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(bodyText);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Spotify search failed';
    res.status(502).json({ error: message });
  }
}
