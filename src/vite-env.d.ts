/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUDIUS_APP_NAME?: string;
  readonly VITE_SPOTIFY_CLIENT_ID?: string;
  /** Must match the Spotify app redirect URI exactly (e.g. ngrok https URL + /spotify/callback). */
  readonly VITE_SPOTIFY_REDIRECT_URI?: string;
  /** Space- or comma-separated scopes; defaults include user-read-private, user-read-email, user-library-read. */
  readonly VITE_SPOTIFY_SCOPES?: string;
  /** Set to "1" to log Spotify token/API response bodies to the console. */
  readonly VITE_DEBUG_SPOTIFY?: string;
  readonly VITE_AO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
