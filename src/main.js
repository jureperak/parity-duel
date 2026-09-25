import { LiveShareClient, TestLiveShareHost, LivePresence } from "@microsoft/live-share";
import { app, pages, meeting, LiveShareHost, FrameContexts } from "@microsoft/teams-js";
import { SharedMap } from "fluid-framework";
import { SIDES, other, parsePick, decide, seatOf, phase, badgeIndex } from "./game.js";
import { WIN_BADGES, LOSE_BADGES, fill } from "./badges.js";
import { avatar, teamsDisplayName, fetchMyPhoto } from "./identity.js";
import "./style.css";

const params = new URLSearchParams(location.search);
const inTeams = params.get("inTeams") === "1";
const root = document.getElementById("app");

// ---------- tiny DOM helper (text only, never innerHTML for remote data) ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const cap = s => s[0].toUpperCase() + s.slice(1);

// ---------- local identity (per tab; survives reload) ----------
function stored(storage, key, make) {
  try {
    let v = storage.getItem(key);
    if (!v) { v = make(); storage.setItem(key, v); }
    return v;
  } catch { return make(); }
}
const me = {
  id: stored(sessionStorage, "eo-id", () => crypto.randomUUID()),
  name: stored(localStorage, "eo-name", () => ""),
  photo: null,
  fromTeams: false, // true once the name comes from the Teams account
};
const seatData = side => ({ id: me.id, name: me.name || `${cap(side)} player`, photo: me.photo });
function updateMySeat() {
  const side = seatOf(read().seats, me.id);
  if (side) map.set(`seat:${side}`, seatData(side));
}
function saveName(name) {
  me.name = name;
  try { localStorage.setItem("eo-name", name); } catch {}
}

// ---------- shared state ----------
let map;       // Fluid SharedMap
let frameContext = null;
let draft = ""; // what I'm typing, kept across re-renders

const read = () => {
  const seats = { even: map.get("seat:even"), odd: map.get("seat:odd") };
  const picks = { even: map.get("pick:even"), odd: map.get("pick:odd") };
  // Names are shown as text only; photos are re-validated in avatar().
  for (const s of SIDES) if (seats[s]) seats[s] = { ...seats[s], name: String(seats[s].name ?? "").slice(0, 64) };
  // Remote data is untrusted: drop picks that aren't valid positive integers.
  for (const s of SIDES) if (picks[s] && parsePick(picks[s].value) === null) picks[s] = undefined;
  return { seats, picks, round: map.get("round") ?? 1 };
};

const actions = {
  sit(side) {
    map.set(`seat:${side}`, seatData(side));
  },
  leave(side) {
    map.delete(`seat:${side}`);
    map.delete(`pick:${side}`);
  },
  lockIn(side, value, round) {
    map.set(`pick:${side}`, { round, value });
    draft = "";
  },
  nextRound(round) {
    map.set("round", round + 1);
  },
  swapSides(seats, round) {
    map.set("seat:even", seats.odd);
    map.set("seat:odd", seats.even);
    map.set("round", round + 1);
  },
  reset() {
    for (const k of ["seat:even", "seat:odd", "pick:even", "pick:odd"]) map.delete(k);
    map.set("round", 1);
  },
};

// ---------- views ----------
let renameTimer;
function nameBar() {
  if (me.fromTeams) {
    return h("div", { class: "namebar" }, avatar(me, 28),
      h("span", { class: "muted" }, "Playing as"), h("strong", {}, me.name));
  }
  const input = h("input", {
    id: "name", maxlength: 24, placeholder: "Your nickname", value: me.name, autocomplete: "off",
    oninput: e => {
      saveName(e.target.value.trim());
      // Rename my seat once typing pauses, so others don't get a write per keystroke.
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => { if (me.name) updateMySeat(); }, 400);
    },
  });
  return h("div", { class: "namebar" }, h("label", { for: "name" }, "Playing as"), input);
}

function seatCard(side, st, mySide) {
  const seat = st.seats[side];
  const mine = mySide === side;
  let body;
  if (seat) {
    body = [
      avatar(seat, 48),
      h("div", { class: "seat-name" }, seat.name, mine ? " (you)" : ""),
      mine ? h("button", { class: "link", onclick: () => actions.leave(side) }, "Leave") : null,
    ];
  } else {
    body = h("button", {
      disabled: !!mySide,
      title: mySide ? "You already have a side" : "",
      onclick: () => actions.sit(side),
    }, `Play ${cap(side)}`);
  }
  return h("section", { class: `seat seat-${side}${mine ? " mine" : ""}` },
    h("div", { class: "seat-label" }, cap(side)), body);
}

const phaseNow = st => phase(st.seats, st.picks, st.round);

function statusChip(side, st) {
  const locked = st.picks[side]?.round === st.round;
  return h("span", { class: `chip ${locked ? "ready" : ""}` },
    `${st.seats[side].name}: `, locked ? "locked in ✓" : "thinking…");
}

function pickingView(st, mySide) {
  const chips = h("div", { class: "chips" }, SIDES.map(s => statusChip(s, st)));
  if (!mySide) return h("div", { class: "panel" }, h("p", {}, "Players are choosing their numbers…"), chips);

  const locked = st.picks[mySide]?.round === st.round;
  if (locked) {
    const opp = st.seats[other(mySide)].name;
    return h("div", { class: "panel" },
      h("p", { class: "big" }, `You picked ${st.picks[mySide].value}.`),
      h("p", { class: "muted pulse" }, `Waiting for ${opp}…`), chips);
  }

  const button = h("button", { type: "submit", disabled: parsePick(draft) === null }, "Lock in");
  const error = h("p", { class: "error", hidden: !draft || parsePick(draft) !== null },
    "Whole numbers from 1 up, max 9 digits.");
  const submit = e => {
    e.preventDefault();
    const n = parsePick(draft);
    if (n !== null) actions.lockIn(mySide, n, st.round);
  };
  return h("form", { class: "panel", onsubmit: submit },
    h("p", {}, `You're ${cap(mySide)}. Pick any positive number:`),
    h("div", { class: "pick-row" },
      h("input", {
        id: "pick", inputmode: "numeric", autocomplete: "off", placeholder: "e.g. 7", value: draft,
        oninput: e => {
          draft = e.target.value;
          const ok = parsePick(draft) !== null;
          button.disabled = !ok;
          error.hidden = !draft || ok;
        },
      }),
      button),
    error,
    chips);
}

function revealView(st, mySide) {
  const e = st.picks.even.value, o = st.picks.odd.value;
  const { sum, winner, loser } = decide(e, o);
  const iLost = mySide === loser;
  const winBadge = WIN_BADGES[badgeIndex(st.round, sum, WIN_BADGES.length)];
  const loseBadge = LOSE_BADGES[badgeIndex(st.round, sum, LOSE_BADGES.length)];
  const vars = {
    winner: st.seats[winner].name, loser: st.seats[loser].name,
    sum, side: winner, Side: cap(winner),
  };
  const headline = mySide === winner ? "You win!" : "Winner";
  const medalArt = badge => {
    const el = h("div", { class: "medal" });
    el.innerHTML = badge.art; // trusted, static SVG from badges.js
    return el;
  };

  return h("div", { class: `panel reveal ${iLost ? "lost" : "won"}` },
    mySide === winner ? confetti() : null,
    h("div", { class: "math" },
      h("div", { class: "addends" }, h("span", { class: "even" }, e), " + ", h("span", { class: "odd" }, o)),
      h("div", { class: "sum" }, sum),
      h("span", { class: `tag ${winner}` }, `${cap(winner)} wins`)),
    h("div", { class: "badge" },
      h("div", { class: "badge-art" }, avatar(st.seats[winner], 96), medalArt(winBadge)),
      h("div", {},
        h("div", { class: "headline" }, headline),
        h("div", { class: "winner-name" }, vars.winner),
        h("div", { class: "badge-title" }, fill(winBadge.title, vars)),
        h("p", { class: "badge-msg" }, fill(winBadge.message, vars)))),
    iLost ? h("div", { class: "consolation" },
      medalArt(loseBadge),
      h("div", {},
        h("div", { class: "consolation-title" }, `Your badge: ${fill(loseBadge.title, vars)}`),
        h("p", { class: "badge-msg" }, fill(loseBadge.message, vars)))) : null,
    mySide ? h("div", { class: "actions" },
      h("button", { onclick: () => actions.nextRound(st.round) }, "Play again"),
      h("button", { class: "secondary", onclick: () => actions.swapSides(st.seats, st.round) }, "Swap sides"))
      : null);
}

function confetti() {
  const colors = ["#ff4a2b", "#ff7a3d", "#e02a73", "#8a3dff", "#b67bff", "#ffd35c"];
  return h("div", { class: "confetti", "aria-hidden": "true" },
    Array.from({ length: 36 }, (_, i) => {
      const s = h("i");
      s.style.left = `${(i * 97) % 100}%`;
      s.style.background = colors[i % colors.length];
      s.style.animationDelay = `${(i % 9) * 0.08}s`;
      return s;
    }));
}

function footer(st) {
  const items = [];
  if (frameContext === FrameContexts.sidePanel) {
    items.push(h("button", { class: "link", onclick: shareToStage }, "Show on meeting stage"));
  }
  if (!inTeams) {
    items.push(h("span", { class: "muted" }, "Local test — open this exact URL in a second tab to join."));
  }
  if (st.seats.even || st.seats.odd) {
    items.push(h("button", { class: "link", onclick: () => actions.reset() }, "Reset game"));
  }
  return h("footer", {}, items);
}

function render() {
  // Remote updates rebuild the page; keep the caret where the user was typing.
  const active = document.activeElement;
  const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const st = read();
  const mySide = seatOf(st.seats, me.id);
  const p = phaseNow(st);

  let main;
  if (p === "lobby") {
    main = h("div", { class: "panel" }, h("p", { class: "muted" },
      mySide ? "Waiting for an opponent to take the other side…" : "Choose a side to play. The sum decides the winner."));
  } else if (p === "picking") {
    main = pickingView(st, mySide);
  } else {
    main = revealView(st, mySide);
  }

  root.replaceChildren(
    h("header", {}, h("h1", {}, "Even or Odd"), h("span", { class: "round" }, `Round ${st.round}`)),
    nameBar(),
    h("div", { class: "seats" }, seatCard("even", st, mySide), h("div", { class: "vs" }, "vs"), seatCard("odd", st, mySide)),
    main,
    footer(st));

  const el = focus && document.getElementById(focus.id);
  if (el) {
    el.focus();
    if (focus.start != null) el.setSelectionRange(focus.start, focus.end);
  }
}

function shareToStage() {
  const url = `${location.origin}${location.pathname}?inTeams=1`;
  meeting.shareAppContentToStage(err => { if (err) console.error("Share to stage failed", err); }, url);
}

// ---------- Teams config page (shown when adding the app to a meeting) ----------
function renderConfig() {
  root.replaceChildren(h("div", { class: "panel" },
    h("h1", {}, "Even or Odd"),
    h("p", {}, "Adds a two-player Even or Odd game to this meeting. Click Save to continue.")));
  pages.config.registerOnSaveHandler(async saveEvent => {
    const contentUrl = `${location.origin}${location.pathname}?inTeams=1`;
    await pages.config.setConfig({
      entityId: "even-odd", suggestedDisplayName: "Even or Odd", contentUrl, websiteUrl: contentUrl,
    });
    saveEvent.notifySuccess();
  });
  pages.config.setValidityState(true);
}

// ---------- startup ----------
async function start() {
  root.replaceChildren(h("div", { class: "panel muted" }, "Connecting…"));

  let host;
  if (inTeams) {
    await app.initialize();
    const ctx = await app.getContext();
    frameContext = ctx.page.frameContext;
    applyTheme(ctx.app.theme);
    app.registerOnThemeChangeHandler(applyTheme);
    if (frameContext === FrameContexts.settings) { renderConfig(); app.notifySuccess(); return; }
    host = LiveShareHost.create();
  } else {
    host = TestLiveShareHost.create();
  }

  const client = new LiveShareClient(host);
  const { container } = await client.joinContainer({
    initialObjects: { game: SharedMap, presence: LivePresence },
  });
  map = container.initialObjects.game;
  map.on("valueChanged", render);

  if (inTeams) {
    const presence = container.initialObjects.presence;
    await presence.initialize();
    const name = await teamsDisplayName(presence);
    if (name) { me.name = name; me.fromTeams = true; }
  }
  render();
  if (inTeams) {
    app.notifySuccess();
    loadMyPhoto();
  }
}

// Optional: needs an Entra app registration (see README). Falls back to initials.
async function loadMyPhoto() {
  try {
    me.photo = await fetchMyPhoto(import.meta.env.VITE_ENTRA_CLIENT_ID);
  } catch (err) {
    console.warn("Profile photo unavailable, using initials", err);
    return;
  }
  if (me.photo) { updateMySeat(); render(); }
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === "dark" ? "dark" : theme === "contrast" ? "contrast" : "light";
}

start().catch(err => {
  console.error(err);
  root.replaceChildren(h("div", { class: "panel error" },
    "Couldn't connect to the game session. ",
    inTeams ? "Try reopening the app in the meeting." : "Is the local sync server running? (npm run sync-server)"));
});
