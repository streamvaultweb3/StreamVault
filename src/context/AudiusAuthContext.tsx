/**
 * Log in with Audius (OAuth) — full Audius experience.
 * Persists user in localStorage; pre-fills permaweb profile Audius handle.
 */
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'streamvault:audius_user';
const TOKEN_STORAGE_KEY = 'streamvault:audius_oauth_token';
const OAUTH_STATE_KEY = 'streamvault:audius_oauth_state';
const AUDIUS_API_BASE = 'https://api.audius.co/v1';

export interface AudiusAuthUser {
  userId: number;
  sub: number;
  handle: string;
  name: string;
  email?: string;
  verified: boolean;
  profilePicture?: { '150x150'?: string; '480x480'?: string; '1000x1000'?: string } | null;
  iat?: string;
}

interface AudiusAuthContextValue {
  audiusUser: AudiusAuthUser | null;
  isInitialized: boolean;
  isAuthReady: boolean;
  isLoggingIn: boolean;
  authError: string | null;
  login: () => void;
  logout: () => void;
  apiKeyConfigured: boolean;
}

const AudiusAuthContext = createContext<AudiusAuthContextValue | null>(null);

function loadStoredUser(): AudiusAuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AudiusAuthUser;
  } catch {
    return null;
  }
}

function storeUser(user: AudiusAuthUser | null) {
  if (typeof window === 'undefined') return;
  if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  else localStorage.removeItem(STORAGE_KEY);
}

function loadStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed?.token || null;
  } catch {
    return null;
  }
}

function storeToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token }));
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function randomString(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

async function verifyAudiusToken(token: string): Promise<AudiusAuthUser> {
  const res = await fetch(`${AUDIUS_API_BASE}/users/verify_token?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Audius verify_token failed (${res.status})`);
  const raw = await res.json();
  const profile = raw?.data ?? raw;

  const rawUserId = profile?.userId ?? profile?.user_id ?? profile?.sub;
  const rawSub = profile?.sub ?? profile?.userId ?? profile?.user_id;
  const userId = Number(rawUserId);
  const sub = Number(rawSub);
  const handle = String(profile?.handle ?? '');
  if (!handle) throw new Error('Audius profile missing handle.');

  return {
    userId: Number.isFinite(userId) ? userId : 0,
    sub: Number.isFinite(sub) ? sub : Number.isFinite(userId) ? userId : 0,
    handle,
    name: String(profile?.name ?? profile?.artist_name ?? ''),
    email: profile?.email,
    verified: Boolean(profile?.verified),
    profilePicture: profile?.profilePicture ?? profile?.profile_picture ?? null,
    iat: profile?.iat,
  };
}

function parseOAuthParams(search: string, hash: string) {
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

export function AudiusAuthProvider({ children }: { children: React.ReactNode }) {
  const [audiusUser, setAudiusUser] = useState<AudiusAuthUser | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const apiKey = typeof import.meta !== 'undefined'
    ? (import.meta.env?.VITE_AUDIUS_API_KEY || import.meta.env?.VITE_API)
    : undefined;
  const apiKeyConfigured = Boolean(apiKey?.trim());
  const redirectUri = typeof import.meta !== 'undefined'
    ? (import.meta.env?.VITE_AUDIUS_REDIRECT_URI || (typeof window !== 'undefined' ? window.location.origin : undefined))
    : undefined;

  useEffect(() => {
    setAudiusUser(loadStoredUser());
    setIsInitialized(true);
  }, []);

  useEffect(() => {
    if (!isInitialized || !apiKey?.trim()) return;

    const { token, state, error } = parseOAuthParams(
      typeof window !== 'undefined' ? window.location.search : '',
      typeof window !== 'undefined' ? window.location.hash : ''
    );

    if (error) {
      setAuthError(`Audius OAuth error: ${error}`);
      setIsLoggingIn(false);
      return;
    }

    if (token && state) {
      const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
      if (!expectedState || state !== expectedState) {
        setAuthError('Audius OAuth state mismatch. Please try again.');
        setIsLoggingIn(false);
        return;
      }

      (async () => {
        try {
          storeToken(token);
          const user = await verifyAudiusToken(token);
          setAudiusUser(user);
          storeUser(user);
          setAuthError(null);
        } catch (e: any) {
          setAuthError(String(e?.message || 'Audius OAuth completion failed.'));
        } finally {
          setIsLoggingIn(false);
          sessionStorage.removeItem(OAUTH_STATE_KEY);
          if (typeof window !== 'undefined') {
            window.history.replaceState({}, '', buildCleanUrlAfterOAuth());
          }
        }
      })();
      return;
    }

    const storedToken = loadStoredToken();
    if (!storedToken) return;

    verifyAudiusToken(storedToken)
      .then((user) => {
        setAudiusUser(user);
        storeUser(user);
      })
      .catch(() => {
        storeToken(null);
      });
  }, [apiKey, isInitialized]);

  const login = useCallback(() => {
    if (!apiKey?.trim()) {
      setAuthError('Audius API key is missing.');
      return;
    }
    if (!redirectUri) {
      setAuthError('Audius redirect URI is missing.');
      return;
    }

    setAuthError(null);
    setIsLoggingIn(true);

    const state = randomString(48);
    sessionStorage.setItem(OAUTH_STATE_KEY, state);

    const authUrl = new URL('https://audius.co/oauth/auth');
    authUrl.searchParams.set('scope', 'read');
    authUrl.searchParams.set('api_key', apiKey.trim());
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('display', 'fullScreen');
    authUrl.searchParams.set('origin', window.location.origin);

    window.location.assign(authUrl.toString());
  }, [apiKey, redirectUri]);

  const logout = useCallback(() => {
    const token = loadStoredToken();
    setAudiusUser(null);
    setAuthError(null);
    setIsLoggingIn(false);
    storeUser(null);
    storeToken(null);

    if (token) {
      fetch(`${AUDIUS_API_BASE}/oauth/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          token,
          client_id: apiKey?.trim() || '',
        }),
      }).catch(() => {
        // best-effort revoke
      });
    }
  }, [apiKey]);

  useEffect(() => {
    setIsAuthReady(apiKeyConfigured);
  }, [apiKeyConfigured]);

  return (
    <AudiusAuthContext.Provider
      value={{
        audiusUser,
        isInitialized,
        isAuthReady,
        isLoggingIn,
        authError,
        login,
        logout,
        apiKeyConfigured,
      }}
    >
      {children}
    </AudiusAuthContext.Provider>
  );
}

export function useAudiusAuth() {
  const ctx = useContext(AudiusAuthContext);
  if (!ctx) throw new Error('useAudiusAuth must be used within AudiusAuthProvider');
  return ctx;
}
