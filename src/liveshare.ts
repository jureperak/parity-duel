// Sync backend for Teams meetings (and local Teams-mode testing): Live Share on
// Fluid Framework. Microsoft's relay orders operations, so there's no referee.
import { LiveShareClient, LivePresence, PresenceState } from "@microsoft/live-share";
import type { ILiveShareHost } from "@microsoft/live-share";
import { SharedMap } from "fluid-framework";
import type { Session, ConnectionStatus } from "./sync.ts";

interface PresenceData {
  playerId: string;
}

/** Presence needs a moment after joining before "not seen" can safely mean "offline". */
const PRESENCE_SETTLE_MS = 5_000;
/**
 * Live Share works out "offline" lazily when presence is read and emits no event
 * when someone times out, so re-check on a timer to notice players who left.
 */
const PRESENCE_RECHECK_MS = 5_000;

export interface LiveShareSession extends Session {
  livePresence: LivePresence<PresenceData>;
}

export async function joinLiveShare(host: ILiveShareHost, playerId: string): Promise<LiveShareSession> {
  const client = new LiveShareClient(host);
  const { container } = await client.joinContainer({
    initialObjects: { game: SharedMap, presence: LivePresence },
  });
  const map = container.initialObjects.game as SharedMap;
  const livePresence = container.initialObjects.presence as LivePresence<PresenceData>;
  await livePresence.initialize({ playerId });

  let settled = false;
  let status: ConnectionStatus = "connected";
  const statusListeners: (() => void)[] = [];
  const setStatus = (s: ConnectionStatus): void => { status = s; statusListeners.forEach(l => l()); };
  container.on("disconnected", () => setStatus("reconnecting"));
  container.on("connected", () => setStatus("connected"));

  return {
    livePresence,
    state: {
      get: key => map.get(key),
      // Fluid applies each op in order; ops from one client are never interleaved with others'.
      apply: ops => { for (const op of ops) { if ("delete" in op) map.delete(op.key); else map.set(op.key, op.value); } },
      subscribe: listener => { map.on("valueChanged", listener); },
    },
    presence: {
      onlinePlayerIds: () => {
        const ids = new Set<string>();
        for (const user of livePresence.getUsers(PresenceState.online)) {
          for (const c of user.getConnections(PresenceState.online)) {
            if (c.data?.playerId) ids.add(c.data.playerId);
          }
        }
        return ids;
      },
      settled: () => settled,
      subscribe: listener => {
        livePresence.on("presenceChanged", listener);
        setTimeout(() => { settled = true; listener(); }, PRESENCE_SETTLE_MS);
        setInterval(listener, PRESENCE_RECHECK_MS);
      },
    },
    status: () => status,
    onStatus: listener => { statusListeners.push(listener); },
  };
}
