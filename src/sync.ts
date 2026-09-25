// What the game needs from a sync backend. Implemented by Live Share (Teams)
// and by PeerJS (browsers); the store and views only ever see this interface.
import type { Op } from "./protocol.ts";

export type ConnectionStatus = "connected" | "reconnecting" | "host-left";

export interface SharedState {
  get(key: string): unknown;
  /** Apply a batch of operations. Batches are atomic: all or nothing. */
  apply(ops: Op[]): void;
  subscribe(listener: () => void): void;
}

export interface Presence {
  onlinePlayerIds(): Set<string>;
  /** True once presence can be trusted to mean "not listed = gone". */
  settled(): boolean;
  subscribe(listener: () => void): void;
}

export interface Session {
  state: SharedState;
  presence: Presence;
  status(): ConnectionStatus;
  onStatus(listener: () => void): void;
}
