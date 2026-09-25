// Connecting to the shared game session. This is the only module that knows
// which sync service is in use (Teams Live Share, or the local test server).
import { LiveShareClient, LivePresence } from "@microsoft/live-share";
import type { ILiveShareHost } from "@microsoft/live-share";
import { SharedMap } from "fluid-framework";
import type { IFluidContainer } from "fluid-framework";
import type { PresenceData } from "./store.ts";

export interface Session {
  container: IFluidContainer;
  map: SharedMap;
  presence: LivePresence<PresenceData>;
}

export async function joinSession(host: ILiveShareHost, playerId: string): Promise<Session> {
  const client = new LiveShareClient(host);
  const { container } = await client.joinContainer({
    initialObjects: { game: SharedMap, presence: LivePresence },
  });
  const map = container.initialObjects.game as SharedMap;
  const presence = container.initialObjects.presence as LivePresence<PresenceData>;
  await presence.initialize({ playerId });
  return { container, map, presence };
}
