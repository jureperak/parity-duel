/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional Entra app (client) ID used to load Teams profile photos. */
  readonly VITE_ENTRA_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
