/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUDIUS_APP_NAME?: string;
  readonly VITE_AO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
