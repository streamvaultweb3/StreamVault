const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

const STORAGE_KEY = 'streamvault:spotify_tokens';
const PKCE_VERIFIER_KEY = 'streamvault:spotify_pkce_verifier';
const OAUTH_STATE_KEY = 'streamvault:spotify_oauth_state';
const OAUTH_REDIRECT_URI_KEY = 'streamvault:spotify_oauth_redirect_uri';
const OAUTH_LAST_CODE_KEY = 'streamvault:spotify_oauth_last_code';
const OAUTH_LAST_CODE_AT_KEY = 'streamvault:spotify_oauth_last_code_at';

// Fallback for cases where the callback opens in a new tab/window, where sessionStorage is empty.
// Note: localStorage is still origin-scoped by the browser; we include origin in the key for clarity.
function getOriginScopedKey(base: string): string {
  if (typeof window === 'undefined') return base;
  return `${base}:${window.location.origin}`;
}

const PKCE_VERIFIER_KEY_LOCAL = getOriginScopedKey('streamvault:spotify_pkce_verifier:local');
const OAUTH_STATE_KEY_LOCAL = getOriginScopedKey('streamvault:spotify_oauth_state:local');
const OAUTH_REDIRECT_URI_KEY_LOCAL = getOriginScopedKey('streamvault:spotify_oauth_redirect_uri:local');

export function isSpotifyDebugEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof import.meta !== 'undefined' && String((import.meta as any)?.env?.VITE_DEBUG_SPOTIFY || '') === '1';
  } catch {
    return false;
  }
}

function spotifyDebugLog(...args: any[]) {
  if (!isSpotifyDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug('[spotify]', ...args);
}

const DEFAULT_SPOTIFY_SCOPES = 'user-read-private user-read-email user-library-read';

/** Space- or comma-separated scopes from VITE_SPOTIFY_SCOPES, or defaults (library read for saved tracks). */
export function getSpotifyScopesFromEnv(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = String((import.meta as any)?.env?.VITE_SPOTIFY_SCOPES || '').trim();
    if (!raw) return DEFAULT_SPOTIFY_SCOPES;
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ');
  } catch {
    return DEFAULT_SPOTIFY_SCOPES;
  }
}

export type SpotifyAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  scope?: string;
  tokenType?: string;
};

export type SpotifyUserProfile = {
  id: string;
  display_name: string | null;
  email?: string;
  images?: Array<{ url: string; height?: number; width?: number }>;
  product?: string;
};

export type SpotifySavedTrackItem = {
  added_at: string;
  track: {
    id: string;
    name: string;
    duration_ms: number;
    artists: Array<{ id: string; name: string }>;
    album: {
      id: string;
      name: string;
      images?: Array<{ url: string; height?: number; width?: number }>;
    };
    external_urls?: { spotify?: string };
  };
};

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadStoredSpotifyTokens(): SpotifyAuthTokens | null {
  if (typeof window === 'undefined') return null;
  return safeJsonParse<SpotifyAuthTokens>(localStorage.getItem(STORAGE_KEY));
}

export function storeSpotifyTokens(tokens: SpotifyAuthTokens | null) {
  if (typeof window === 'undefined') return;
  if (!tokens) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

function randomString(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  const b64 = btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

export async function createPkcePair() {
  const verifier = randomString(96);
  const challenge = base64UrlEncode(await sha256(verifier));
  return { verifier, challenge };
}

export function getDefaultSpotifyRedirectUri(): string {
  if (typeof window === 'undefined') return '';
  // Spotify OAuth redirect URIs should not include a fragment (#).
  // Even if the app uses HashRouter, we can redirect /spotify/callback -> #/spotify/callback at runtime.
  return `${window.location.origin}/spotify/callback`;
}

export function normalizeSpotifyRedirectUri(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    // Spotify compares redirect URIs exactly. Ensure we never include a hash.
    u.hash = '';
    // Also avoid carrying a query string in redirect_uri.
    u.search = '';
    return u.toString();
  } catch {
    // If it's not a valid absolute URL, leave it unchanged; caller can fallback.
    return trimmed;
  }
}

export function buildSpotifyAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
}): string {
  const url = new URL(`${SPOTIFY_ACCOUNTS_BASE}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('state', args.state);
  url.searchParams.set('scope', args.scope);
  return url.toString();
}

export function beginSpotifyLogin(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
}): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return (async () => {
    const clientId = String(params.clientId || '').trim();
    if (!clientId) {
      throw new Error('Spotify client id is missing. Set VITE_SPOTIFY_CLIENT_ID in .env.local.');
    }
    const { verifier, challenge } = await createPkcePair();
    const state = randomString(48);
    const redirectUri = normalizeSpotifyRedirectUri(params.redirectUri) || getDefaultSpotifyRedirectUri();
    if (!redirectUri) {
      throw new Error('Spotify redirect URI is empty. Set VITE_SPOTIFY_REDIRECT_URI to match the Spotify app redirect exactly.');
    }
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
    sessionStorage.setItem(OAUTH_REDIRECT_URI_KEY, redirectUri);

    // Fallback for new-tab callbacks
    localStorage.setItem(PKCE_VERIFIER_KEY_LOCAL, verifier);
    localStorage.setItem(OAUTH_STATE_KEY_LOCAL, state);
    localStorage.setItem(OAUTH_REDIRECT_URI_KEY_LOCAL, redirectUri);

    spotifyDebugLog('begin login', {
      origin: window.location.origin,
      redirectUri,
      hasSessionStorage: true,
      statePrefix: state.slice(0, 8),
      verifierPrefix: verifier.slice(0, 8),
    });
    // New login attempt, so allow processing a new code.
    sessionStorage.removeItem(OAUTH_LAST_CODE_KEY);
    sessionStorage.removeItem(OAUTH_LAST_CODE_AT_KEY);
    const authUrl = buildSpotifyAuthorizeUrl({
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state,
      scope: params.scope,
    });
    // Full-page navigation to Spotify (avoid form submit / hash-only navigation).
    window.location.assign(authUrl);
  })();
}

export function getSpotifyRedirectUriForExchange(fallbackRedirectUri: string): string {
  if (typeof window === 'undefined') return normalizeSpotifyRedirectUri(fallbackRedirectUri);
  const stored = sessionStorage.getItem(OAUTH_REDIRECT_URI_KEY) || localStorage.getItem(OAUTH_REDIRECT_URI_KEY_LOCAL);
  return normalizeSpotifyRedirectUri(stored || '') || normalizeSpotifyRedirectUri(fallbackRedirectUri) || getDefaultSpotifyRedirectUri();
}

export function wasSpotifyOAuthCodeProcessed(code: string, withinMs = 2 * 60 * 1000): boolean {
  if (typeof window === 'undefined') return false;
  const lastCode = sessionStorage.getItem(OAUTH_LAST_CODE_KEY);
  const at = Number(sessionStorage.getItem(OAUTH_LAST_CODE_AT_KEY) || 0);
  if (!lastCode || !at) return false;
  if (lastCode !== code) return false;
  return Date.now() - at <= withinMs;
}

export function markSpotifyOAuthCodeProcessed(code: string) {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(OAUTH_LAST_CODE_KEY, code);
  sessionStorage.setItem(OAUTH_LAST_CODE_AT_KEY, String(Date.now()));
}

export function parseOAuthParams(search: string, hash: string) {
  const query = new URLSearchParams(search || '');
  const rawHash = (hash || '').replace(/^#/, '');

  let hashParams = new URLSearchParams(rawHash);
  if (rawHash.includes('?')) {
    hashParams = new URLSearchParams(rawHash.split('?')[1] || '');
  }

  return {
    code: query.get('code') || hashParams.get('code'),
    state: query.get('state') || hashParams.get('state'),
    error: query.get('error') || hashParams.get('error'),
  };
}

function buildCleanUrlAfterOAuth() {
  if (typeof window === 'undefined') return '/';
  const rawHash = (window.location.hash || '').replace(/^#/, '');
  if (rawHash.includes('?')) {
    const hashPath = rawHash.split('?')[0] || '';
    return `${window.location.origin}${window.location.pathname}${hashPath ? `#${hashPath}` : ''}`;
  }
  return `${window.location.origin}${window.location.pathname}${window.location.hash || ''}`;
}

async function tokenRequest(body: URLSearchParams): Promise<any> {
  const res = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const rawText = await res.text();
  let raw: Record<string, unknown> | null = null;
  if (rawText.trim()) {
    try {
      raw = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      raw = null;
    }
  }
  if (!res.ok) {
    if (isSpotifyDebugEnabled()) {
      const wwwAuth = res.headers.get('www-authenticate');
      if (wwwAuth) spotifyDebugLog('token WWW-Authenticate', wwwAuth);
      spotifyDebugLog('token endpoint error', { status: res.status, bodyText: rawText });
    }
    const errObj = raw?.error;
    const msg =
      (raw?.error_description as string | undefined) ||
      (typeof errObj === 'object' && errObj && 'message' in errObj
        ? String((errObj as { message?: string }).message || '')
        : '') ||
      (typeof errObj === 'string' ? errObj : '') ||
      (rawText.trim() ? rawText.trim() : `Spotify token error (${res.status})`);
    throw new Error(`${msg} [HTTP ${res.status}]`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      `Spotify token response was not valid JSON [HTTP ${res.status}] | ${rawText?.slice(0, 400) || '(empty)'}`
    );
  }
  return raw;
}

function spotifyApiFailureMessage(path: string, status: number, parsed: unknown, rawBodyText: string): string {
  const bodyText = rawBodyText.trim();
  const o =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { error?: { message?: string; reason?: string; status?: number } })
      : null;
  const spotifyMsg = o?.error?.message || o?.error?.reason || '';
  let detail = bodyText;
  if (!detail) {
    try {
      detail = parsed !== undefined ? JSON.stringify(parsed) : '(empty body)';
    } catch {
      detail = '(unserializable body)';
    }
  }
  const truncated = detail.length > 900 ? `${detail.slice(0, 900)}…` : detail;
  let msg = `${spotifyMsg || `Spotify API error`} — ${path} [HTTP ${status}] | ${truncated}`;
  if (status === 403 && path.replace(/\?.*$/, '') === '/me') {
    msg +=
      ' | Hint: Development mode (see https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide ) — add this Spotify user under Users in the Developer Dashboard (max 5 users), ensure Premium where required, check you did not authorize a different account, and include user-read-private in scopes. Try an incognito window if you use multiple Spotify logins.';
    // eslint-disable-next-line no-console
    console.error('[spotify] /v1/me returned 403', { status, bodyText, parsed });
  } else if (isSpotifyDebugEnabled()) {
    spotifyDebugLog('API error body', { path, status, bodyText, parsed });
  }
  return msg;
}

export async function exchangeSpotifyCodeForTokens(args: {
  clientId: string;
  redirectUri: string;
  code: string;
}): Promise<SpotifyAuthTokens> {
  if (typeof window === 'undefined') throw new Error('Spotify OAuth must run in browser.');
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY) || localStorage.getItem(PKCE_VERIFIER_KEY_LOCAL);
  if (!verifier) throw new Error('Missing Spotify PKCE verifier. Please try connecting again.');

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', args.clientId);
  body.set('code', args.code);
  body.set('redirect_uri', args.redirectUri);
  body.set('code_verifier', verifier);

  const raw = await tokenRequest(body);
  const expiresInSec = Number(raw?.expires_in || 0);
  const expiresAtMs = Date.now() + Math.max(0, expiresInSec - 20) * 1000;
  return {
    accessToken: String(raw?.access_token || ''),
    refreshToken: raw?.refresh_token ? String(raw.refresh_token) : undefined,
    expiresAtMs,
    scope: raw?.scope ? String(raw.scope) : undefined,
    tokenType: raw?.token_type ? String(raw.token_type) : undefined,
  };
}

export async function refreshSpotifyAccessToken(args: {
  clientId: string;
  refreshToken: string;
}): Promise<SpotifyAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', args.clientId);
  body.set('refresh_token', args.refreshToken);

  const raw = await tokenRequest(body);
  const expiresInSec = Number(raw?.expires_in || 0);
  const expiresAtMs = Date.now() + Math.max(0, expiresInSec - 20) * 1000;

  return {
    accessToken: String(raw?.access_token || ''),
    refreshToken: raw?.refresh_token ? String(raw.refresh_token) : args.refreshToken,
    expiresAtMs,
    scope: raw?.scope ? String(raw.scope) : undefined,
    tokenType: raw?.token_type ? String(raw.token_type) : undefined,
  };
}

/**
 * GET from api.spotify.com with Bearer token. Spotify allows browser calls; if the error body looks empty in-app,
 * check DevTools Network for the real response. To verify the token outside the browser:
 * `curl -sS -H "Authorization: Bearer <token>" https://api.spotify.com/v1/me`
 */
export async function spotifyApiFetch<T>(
  path: string,
  args: { accessToken: string; signal?: AbortSignal }
): Promise<T> {
  const accessToken = String(args.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('Spotify access token is missing — Authorization header would be invalid. Reconnect Spotify.');
  }
  // Real Spotify access tokens are long opaque strings; a very short value usually means a bug or truncated storage.
  if (accessToken.length < 20) {
    throw new Error(
      `Spotify access token looks invalid (length ${accessToken.length}). Reconnect Spotify and check the token exchange.`
    );
  }

  const res = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: args.signal,
  });

  if (!res.ok) {
    const wwwAuth = res.headers.get('www-authenticate');
    if (isSpotifyDebugEnabled() && wwwAuth) {
      spotifyDebugLog('WWW-Authenticate', wwwAuth);
    }
    const rawBodyText = await res.text();
    let parsed: unknown = null;
    if (rawBodyText.trim()) {
      try {
        parsed = JSON.parse(rawBodyText);
      } catch {
        parsed = null;
      }
    }
    throw new Error(spotifyApiFailureMessage(path, res.status, parsed, rawBodyText));
  }
  return (await res.json()) as T;
}

export async function fetchSpotifyMe(accessToken: string, signal?: AbortSignal): Promise<SpotifyUserProfile> {
  return await spotifyApiFetch<SpotifyUserProfile>('/me', { accessToken, signal });
}

export async function fetchSpotifySavedTracks(
  accessToken: string,
  limit = 12,
  signal?: AbortSignal
): Promise<SpotifySavedTrackItem[]> {
  const data = await spotifyApiFetch<{ items: SpotifySavedTrackItem[] }>(`/me/tracks?limit=${limit}`, {
    accessToken,
    signal,
  });
  return data?.items || [];
}

export function clearSpotifyOAuthSession() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(OAUTH_REDIRECT_URI_KEY);

  localStorage.removeItem(PKCE_VERIFIER_KEY_LOCAL);
  localStorage.removeItem(OAUTH_STATE_KEY_LOCAL);
  localStorage.removeItem(OAUTH_REDIRECT_URI_KEY_LOCAL);
}

export function getExpectedSpotifyState(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(OAUTH_STATE_KEY) || localStorage.getItem(OAUTH_STATE_KEY_LOCAL);
}

export function finalizeSpotifyOAuthUrlCleanup() {
  if (typeof window === 'undefined') return;
  window.history.replaceState({}, '', buildCleanUrlAfterOAuth());
}

export function isTokenExpired(tokens: SpotifyAuthTokens | null): boolean {
  if (!tokens?.accessToken) return true;
  return Date.now() >= (tokens.expiresAtMs || 0);
}

