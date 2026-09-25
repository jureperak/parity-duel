// Startup: pick the mode (Teams, local test, or public landing page), join the
// shared session, and re-render whenever anything changes.
import "@fontsource-variable/unbounded";
import "@fontsource-variable/manrope";
import "./style.css";
import type { ILiveShareHost } from "@microsoft/live-share";
import type { GameStore, Me } from "./store.ts";
import { isLocalHost } from "./env.ts";
import { renderGame, renderLanding, renderMessage } from "./views.ts";
import { teamsDisplayName, fetchMyPhoto } from "./identity.ts";

// The game engine (Live Share, Fluid, Teams SDK) is ~1.3 MB, so it's only
// loaded once a game actually starts, never for the public landing page.

const inTeams = new URLSearchParams(location.search).get("inTeams") === "1";
const localTest = !inTeams && isLocalHost(location.hostname);

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app element");

function stored(storage: Storage, key: string, make: () => string): string {
  try {
    let v = storage.getItem(key);
    if (!v) { v = make(); storage.setItem(key, v); }
    return v;
  } catch {
    return make();
  }
}

async function start(app: HTMLElement): Promise<void> {
  if (!inTeams && !localTest) return renderLanding(app);
  renderMessage(app, "Even or Odd", "Connecting…");

  const [{ joinSession }, { GameStore }] = await Promise.all([import("./session.ts"), import("./store.ts")]);
  const teams = inTeams ? await import("./teams.ts") : null;

  let host: ILiveShareHost;
  let sidePanel = false;
  if (teams) {
    const ctx = await teams.initTeams();
    if (teams.isConfigPage(ctx)) { teams.renderConfig(app); teams.notifyLoaded(); return; }
    sidePanel = teams.isSidePanel(ctx);
    host = (await import("@microsoft/teams-js")).LiveShareHost.create();
  } else {
    host = (await import("@microsoft/live-share")).TestLiveShareHost.create();
  }

  const me: Me = {
    id: stored(sessionStorage, "eo-id", () => crypto.randomUUID()),
    name: inTeams ? "" : stored(localStorage, "eo-name", () => ""),
    photo: null,
    fromTeams: false,
  };

  const { container, presence, map } = await joinSession(host, me.id);
  if (inTeams) {
    const name = await teamsDisplayName(presence);
    if (name) { me.name = name; me.fromTeams = true; }
  }

  let connected = true;
  const render = (): void => renderGame(app, {
    store, connected, localTest, onShareToStage: sidePanel ? teams?.shareToStage : undefined,
  });
  const store = new GameStore(map, presence, me, render);
  container.on("disconnected", () => { connected = false; render(); });
  container.on("connected", () => { connected = true; render(); });
  store.start();

  if (teams) {
    teams.notifyLoaded();
    void loadMyPhoto(me, store);
  }
}

// Optional: needs an Entra app registration (see README). Falls back to initials.
async function loadMyPhoto(me: Me, store: GameStore): Promise<void> {
  try {
    me.photo = await fetchMyPhoto(import.meta.env.VITE_ENTRA_CLIENT_ID);
  } catch (err) {
    console.warn("Profile photo unavailable, using initials", err);
    return;
  }
  if (me.photo) store.refreshMySeat();
}

start(root).catch((err: unknown) => {
  console.error(err);
  renderMessage(root, "Couldn't connect",
    "The game session couldn't be reached.",
    inTeams ? "Close the app and open it again from the meeting." : "Is the local sync server running? Start it with npm run sync-server.");
});
