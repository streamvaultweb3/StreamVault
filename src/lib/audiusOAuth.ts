/**
 * Audius "Log in with Audius" helpers — redirect URI must match the page origin
 * so OAuth state stored in the browser is available on callback (multi-domain PWA).
 */

const OAUTH_PENDING_KEY = 'streamvault:audius_oauth_pending';
const OAUTH_MAX_AGE_MS = 15 * 60 * 1000;

export type AudiusOAuthPending = {
  state: string;
  redirectUri: string;
  createdAt: number;
};

/** Origin-only redirect URI for the current page (register each production host in Audius app settings). */
export function resolveAudiusRedirectUri(): string {
  if (typeof window === 'undefined') return '';

  const origin = window.location.origin;
  const envUri = (import.meta.env?.VITE_AUDIUS_REDIRECT_URI as string | undefined)?.trim();

  if (!envUri) return origin;

  try {
    const envOrigin = new URL(envUri).origin;
    if (envOrigin === origin) {
      // Allow env override when it matches this host (e.g. explicit path if Audius requires it).
      return envUri.replace(/\/$/, '') || origin;
    }
    if (import.meta.env.DEV) {
      console.warn(
        '[audius] VITE_AUDIUS_REDIRECT_URI host does not match this site; using',
        origin,
        '(register every deploy host in Audius developer settings).'
      );
    }
    return origin;
  } catch {
    return origin;
  }
}

export function saveAudiusOAuthPending(state: string, redirectUri: string): void {
  if (typeof window === 'undefined') return;
  const payload: AudiusOAuthPending = { state, redirectUri, createdAt: Date.now() };
  try {
    localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(payload));
  } catch {
    // private mode / quota
    sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(payload));
  }
}

export function loadAudiusOAuthPending(): AudiusOAuthPending | null {
  if (typeof window === 'undefined') return null;
  const raw =
    localStorage.getItem(OAUTH_PENDING_KEY) ?? sessionStorage.getItem(OAUTH_PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AudiusOAuthPending;
    if (!parsed?.state || !parsed.redirectUri || !parsed.createdAt) return null;
    if (Date.now() - parsed.createdAt > OAUTH_MAX_AGE_MS) {
      clearAudiusOAuthPending();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearAudiusOAuthPending(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(OAUTH_PENDING_KEY);
  sessionStorage.removeItem(OAUTH_PENDING_KEY);
}

const OAUTH_PARAM_KEYS = ['token', 'state', 'error', 'code'] as const;

export function parseAudiusOAuthParams(search: string, hash: string) {
  const query = new URLSearchParams(search || '');
  const rawHash = (hash || '').replace(/^#/, '');

  let hashParams = new URLSearchParams(rawHash);
  if (rawHash.includes('?')) {
    hashParams = new URLSearchParams(rawHash.split('?')[1] || '');
  }

  return {
    token: query.get('token') || hashParams.get('token'),
    state: query.get('state') || hashParams.get('state'),
    error: query.get('error') || hashParams.get('error'),
    code: query.get('code') || hashParams.get('code'),
  };
}

/** Remove OAuth query/hash params so refresh does not re-run callback handling. */
export function buildCleanUrlAfterAudiusOAuth(): string {
  if (typeof window === 'undefined') return '/';

  const url = new URL(window.location.href);
  for (const key of OAUTH_PARAM_KEYS) {
    url.searchParams.delete(key);
  }

  const rawHash = url.hash.replace(/^#/, '');
  if (rawHash.includes('?')) {
    const [hashPath, hashQuery] = rawHash.split('?', 2);
    const hashParams = new URLSearchParams(hashQuery);
    for (const key of OAUTH_PARAM_KEYS) {
      hashParams.delete(key);
    }
    const rest = hashParams.toString();
    url.hash = hashPath ? `#${hashPath}${rest ? `?${rest}` : ''}` : '';
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
