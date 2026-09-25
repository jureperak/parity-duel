/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional Entra app (client) ID used to load Teams profile photos. */
  readonly VITE_ENTRA_CLIENT_ID?: string;
  /** Optional self-hosted PeerJS signaling server; defaults to the PeerJS cloud. */
  readonly VITE_PEERJS_HOST?: string;
  readonly VITE_PEERJS_PORT?: string;
  readonly VITE_PEERJS_PATH?: string;
  readonly VITE_PEERJS_SECURE?: string;
  /** PeerJS log level 0-3; 3 logs every connection step. */
  readonly VITE_PEERJS_DEBUG?: string;
  /** Optional TURN relay for strict networks: comma-separated turn:/turns: URLs plus credentials. */
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
