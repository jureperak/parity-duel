// Startup. Three modes:
//   Teams meeting   (?inTeams=1)        Live Share, synced by Microsoft
//   Browser         (default)           PeerJS: start screen, then host or guest
//   Local Teams dev (?dev=fluid, localhost only)  Live Share against `npm run sync-server`
import "@fontsource-variable/unbounded";
import "@fontsource-variable/manrope";
import "./style.css";
import { GameStore } from "./store.ts";
import type { Me } from "./store.ts";
import type { Session } from "./sync.ts";
import type * as TeamsModule from "./teams.ts";
import { isLocalHost } from "./env.ts";
import { h } from "./dom.ts";
import { renderGame, renderStart, renderMessage } from "./views.ts";
import { teamsDisplayName, fetchMyPhoto } from "./identity.ts";

// Heavy code (Live Share + Fluid ~1.2 MB, PeerJS) is loaded only by the mode that needs it.
// store.ts, views.ts and game rules are small and shared by every mode.

const params = new URLSearchParams(location.search);
const inTeams = params.get("inTeams") === "1";
const fluidDev = !inTeams && params.get("dev") === "fluid" && isLocalHost(location.hostname);
const HOSTED_GAME_KEY = "eo-host"; // the game this tab created, so a reload resumes as host

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

const me: Me = {
  id: stored(sessionStorage, "eo-id", () => crypto.randomUUID()),
  name: inTeams ? "" : stored(localStorage, "eo-name", () => ""),
  photo: null,
  fromTeams: false,
};

async function newGame(): Promise<void> {
  const { newGameId } = await import("./p2p.ts");
  const id = newGameId();
  try { sessionStorage.setItem(HOSTED_GAME_KEY, id); } catch { /* host won't survive a reload */ }
  location.hash = id; // triggers hashchange -> reload into the game
}
const startNewGame = (): void => {
  newGame().catch((err: unknown) => console.error("Couldn't start a game", err));
};

/** Run the game UI on a connected session. */
function play(app: HTMLElement, session: Session, extra: { inviteUrl?: string; onShareToStage?: () => void }): GameStore {
  const store: GameStore = new GameStore(session.state, session.presence, me, () => render());
  function render(): void {
    renderGame(app, { store, status: session.status(), onNewGame: startNewGame, ...extra });
  }
  session.onStatus(render);
  store.start();
  return store;
}

async function startBrowser(app: HTMLElement): Promise<void> {
  const gameId = location.hash.slice(1);
  if (!gameId) return renderStart(app, startNewGame);

  const p2p = await import("./p2p.ts");
  if (!p2p.GAME_ID_RE.test(gameId)) {
    return renderMessage(app, "That link doesn't look right",
      "Invite links look like …/#eo-abc123def456.", h("button", { onclick: startNewGame }, "Start a new game"));
  }

  let hosted: string | null = null;
  try { hosted = sessionStorage.getItem(HOSTED_GAME_KEY); } catch { /* treat as guest */ }
  const isHost = hosted === gameId;
  renderMessage(app, "Even or Odd", isHost ? "Opening your game…" : "Joining the game…");

  let session: Session;
  try {
    session = isHost ? await p2p.hostGame(gameId, me.id) : await p2p.joinGame(gameId, me.id);
  } catch (err) {
    if (err instanceof p2p.GameNotFoundError) {
      return renderMessage(app, "Game not found",
        "The host may have closed the game, or the link is old.",
        h("button", { onclick: startNewGame }, "Start a new game"));
    }
    throw err;
  }
  play(app, session, { inviteUrl: location.href });
}

async function startLiveShare(app: HTMLElement): Promise<void> {
  const { joinLiveShare } = await import("./liveshare.ts");
  let onShareToStage: (() => void) | undefined;
  let host;
  let teams: typeof TeamsModule | undefined;
  if (inTeams) {
    teams = await import("./teams.ts");
    const ctx = await teams.initTeams();
    if (teams.isConfigPage(ctx)) { teams.renderConfig(app); teams.notifyLoaded(); return; }
    if (teams.isSidePanel(ctx)) onShareToStage = teams.shareToStage;
    host = (await import("@microsoft/teams-js")).LiveShareHost.create();
  } else {
    host = (await import("@microsoft/live-share")).TestLiveShareHost.create();
  }

  const session = await joinLiveShare(host, me.id);
  if (inTeams) {
    const name = await teamsDisplayName(session.livePresence);
    if (name) { me.name = name; me.fromTeams = true; }
  }
  const store = play(app, session, { onShareToStage });
  if (teams) {
    teams.notifyLoaded();
    void loadMyPhoto(store);
  }
}

// Optional: needs an Entra app registration (see README). Falls back to initials.
async function loadMyPhoto(store: GameStore): Promise<void> {
  try {
    me.photo = await fetchMyPhoto(import.meta.env.VITE_ENTRA_CLIENT_ID);
  } catch (err) {
    console.warn("Profile photo unavailable, using initials", err);
    return;
  }
  if (me.photo) store.refreshMySeat();
}

// A different game link means a different game: start clean.
window.addEventListener("hashchange", () => { if (!inTeams && !fluidDev) location.reload(); });

const start = inTeams || fluidDev ? startLiveShare : startBrowser;
renderMessage(root, "Even or Odd", "Loading…");
start(root).catch((err: unknown) => {
  console.error(err);
  renderMessage(root, "Couldn't connect",
    inTeams ? "Close the app and open it again from the meeting."
      : fluidDev ? "Is the local sync server running? Start it with npm run sync-server."
        : "Check your internet connection and try again. Some networks block direct browser connections.",
    inTeams || fluidDev ? null : h("button", { onclick: () => location.reload() }, "Try again"));
});
