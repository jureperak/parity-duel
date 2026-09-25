// Rendering. Everything is rebuilt from the store on each change; the only
// local UI state is the number being typed and the nickname field.
import { h, cap } from "./dom.ts";
import type { Child } from "./dom.ts";
import { SIDES, other, parsePick, badgeIndex, winnerOf } from "./game.ts";
import type { Side, Round, Outcome } from "./game.ts";
import { WIN_BADGES, LOSE_BADGES, fill } from "./badges.ts";
import type { Badge, BadgeVars } from "./badges.ts";
import { avatar } from "./identity.ts";
import type { GameStore } from "./store.ts";

export interface ViewContext {
  store: GameStore;
  connected: boolean;
  localTest: boolean;
  /** Present only in the Teams side panel. */
  onShareToStage?: () => void;
}

let draft = "";
let renameTimer: ReturnType<typeof setTimeout> | undefined;

export function renderGame(root: HTMLElement, ctx: ViewContext): void {
  // Remote updates rebuild the page; keep the caret where the user was typing.
  const active = document.activeElement;
  const focus = active instanceof HTMLInputElement && active.id
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
    : null;

  const { store } = ctx;
  const r = store.snapshot();
  const outcome = store.outcome(r);
  const mySide = store.mySide(r);

  const banner = ctx.connected ? [] : [h("div", { class: "banner", role: "alert" }, "Connection lost. Reconnecting…")];
  root.replaceChildren(
    ...banner,
    h("header", {}, h("h1", {}, "Even or Odd"), h("span", { class: "round" }, `Round ${r.round}`)),
    nameBar(store),
    h("div", { class: "seats" },
      seatCard("even", r, mySide, store), h("div", { class: "vs" }, "vs"), seatCard("odd", r, mySide, store)),
    h("div", { role: "status", "aria-live": "polite" }, mainPanel(r, outcome, mySide, store)),
    footer(r, ctx));

  const el = focus && document.getElementById(focus.id);
  if (focus && el instanceof HTMLInputElement) {
    el.focus();
    if (focus.start != null) el.setSelectionRange(focus.start, focus.end);
  }
}

// ---------- header pieces ----------

function nameBar(store: GameStore): HTMLElement {
  const { me } = store;
  if (me.fromTeams) {
    return h("div", { class: "namebar" }, avatar(me, 28),
      h("span", { class: "muted" }, "Playing as"), h("strong", {}, me.name));
  }
  const input = h("input", {
    id: "name", maxlength: 24, placeholder: "Your nickname", value: me.name, autocomplete: "off",
    oninput: (e: Event) => {
      me.name = (e.target as HTMLInputElement).value.trim();
      try { localStorage.setItem("eo-name", me.name); } catch { /* not persisted; fine */ }
      // Rename my seat once typing pauses, so others don't get a write per keystroke.
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => { if (me.name) store.refreshMySeat(); }, 400);
    },
  });
  return h("div", { class: "namebar" }, h("label", { for: "name" }, "Playing as"), input);
}

function seatCard(side: Side, r: Round, mySide: Side | null, store: GameStore): HTMLElement {
  const seat = r.seats[side];
  const mine = mySide === side;
  const online = store.isOnline(seat);
  let body: Child;
  if (seat) {
    body = [
      avatar(seat, 48),
      h("div", { class: "seat-name" }, seat.name, mine ? " (you)" : ""),
      !online ? h("span", { class: "chip away" }, "Left the game") : null,
      mine ? h("button", { class: "link", onclick: () => store.leave() }, "Leave") : null,
      !online && !mySide
        ? h("button", { onclick: () => store.sit(side) }, `Take over ${cap(side)}`)
        : null,
    ];
  } else {
    body = h("button", {
      disabled: !!mySide,
      title: mySide ? "You already have a side" : "",
      onclick: () => store.sit(side),
    }, `Play ${cap(side)}`);
  }
  return h("section", { class: `seat seat-${side}${mine ? " mine" : ""}${seat && !online ? " away" : ""}` },
    h("div", { class: "seat-label" }, cap(side)), body);
}

// ---------- main panel per phase ----------

const nameOn = (r: Round, side: Side): string => r.seats[side]?.name ?? cap(side);

function mainPanel(r: Round, o: Outcome, mySide: Side | null, store: GameStore): HTMLElement {
  switch (o.kind) {
    case "lobby":
      return h("div", { class: "panel" }, h("p", { class: "muted" },
        mySide ? "Waiting for an opponent to take the other side…" : "Choose a side to play. The sum decides the winner."));
    case "picking":
      return pickingView(r, mySide, store);
    case "revealing":
      return h("div", { class: "panel" },
        h("p", { class: "big" }, "Both locked in."),
        h("p", { class: "muted pulse" },
          `Revealing and verifying ${o.waitingFor.map(s => nameOn(r, s)).join(" and ")}…`));
    case "win":
    case "forfeit":
      return resultView(r, o, mySide, store);
    case "void":
      return h("div", { class: "panel reveal lost" },
        h("p", { class: "big" }, "Round voided"),
        h("p", { class: "muted" }, o.reason === "no-reveal"
          ? "Neither number was revealed in time, so nobody wins this one."
          : "Neither number matched its commitment, so nobody wins this one."),
        mySide ? roundActions(store) : null);
  }
}

function statusChip(side: Side, r: Round): HTMLElement {
  const locked = r.commits[side]?.round === r.round;
  return h("span", { class: `chip ${locked ? "ready" : ""}` },
    `${nameOn(r, side)}: `, locked ? "locked in ✓" : "thinking…");
}

function pickingView(r: Round, mySide: Side | null, store: GameStore): HTMLElement {
  const chips = h("div", { class: "chips" }, SIDES.map(s => statusChip(s, r)));
  if (!mySide) return h("div", { class: "panel" }, h("p", {}, "Players are choosing their numbers…"), chips);

  const opponent = r.seats[other(mySide)];
  const opponentGone = !store.isOnline(opponent)
    ? h("p", { class: "muted" }, `${opponent?.name ?? "Your opponent"} left. Anyone can take over their side.`)
    : null;

  if (r.commits[mySide]?.round === r.round) {
    const mine = store.myPendingPick(r);
    return h("div", { class: "panel" },
      h("p", { class: "big" }, mine !== null ? `You picked ${mine}.` : "You're locked in."),
      h("p", { class: "muted pulse" }, `Waiting for ${nameOn(r, other(mySide))}…`),
      h("p", { class: "fine" }, "Your number stays sealed until both players have locked in."),
      opponentGone, chips);
  }

  const button = h("button", { type: "submit", disabled: parsePick(draft) === null }, "Lock in");
  const error = h("p", { class: "error", hidden: !draft || parsePick(draft) !== null },
    "Whole numbers from 1 up, max 9 digits.");
  const submit = (e: Event) => {
    e.preventDefault();
    const n = parsePick(draft);
    if (n === null) return;
    button.disabled = true;
    draft = "";
    store.lockIn(n).catch((err: unknown) => {
      console.error("Lock in failed", err);
      button.disabled = false;
    });
  };
  return h("form", { class: "panel", onsubmit: submit },
    h("p", {}, `You're ${cap(mySide)}. Pick any positive number:`),
    h("div", { class: "pick-row" },
      h("input", {
        id: "pick", inputmode: "numeric", autocomplete: "off", placeholder: "e.g. 7", value: draft,
        "aria-label": "Your number",
        oninput: (e: Event) => {
          draft = (e.target as HTMLInputElement).value;
          const ok = parsePick(draft) !== null;
          button.disabled = !ok;
          error.hidden = !draft || ok;
        },
      }),
      button),
    error,
    opponentGone,
    chips);
}

function medalArt(badge: Badge): HTMLElement {
  const el = h("div", { class: "medal" });
  el.innerHTML = badge.art; // trusted, static SVG from badges.ts
  return el;
}

type Decided = Extract<Outcome, { kind: "win" | "forfeit" }>;

function resultView(r: Round, o: Decided, mySide: Side | null, store: GameStore): HTMLElement {
  const winner = winnerOf(o)!;
  const loser = o.loser;
  const iLost = mySide === loser;
  const sum = o.kind === "win" ? o.sum : 0;
  const vars: BadgeVars = {
    winner: nameOn(r, winner), loser: nameOn(r, loser), sum, side: winner, Side: cap(winner),
  };
  const winBadge = WIN_BADGES[badgeIndex(r.round, sum, WIN_BADGES.length)];
  const loseBadge = LOSE_BADGES[badgeIndex(r.round, sum, LOSE_BADGES.length)];

  const forfeitWhy = o.kind === "forfeit"
    ? (o.reason === "no-reveal"
      ? `${vars.loser} didn't reveal their number in time.`
      : `${vars.loser}'s number didn't match what they locked in.`)
    : "";

  const math = o.kind === "win"
    ? h("div", { class: "math" },
      h("div", { class: "addends" },
        h("span", { class: "even" }, o.picks.even), " + ", h("span", { class: "odd" }, o.picks.odd)),
      h("div", { class: "sum" }, o.sum),
      h("span", { class: `tag ${winner}` }, `${cap(winner)} wins`))
    : h("div", { class: "math" },
      h("div", { class: "sum sum-word" }, "Forfeit"),
      h("span", { class: `tag ${winner}` }, `${cap(winner)} wins`));

  return h("div", { class: `panel reveal ${iLost ? "lost" : "won"}` },
    mySide === winner ? confetti() : null,
    math,
    h("div", { class: "badge" },
      h("div", { class: "badge-art" }, avatar(r.seats[winner], 96), medalArt(winBadge)),
      h("div", {},
        h("div", { class: "headline" }, mySide === winner ? "You win!" : "Winner"),
        h("div", { class: "winner-name" }, vars.winner),
        h("div", { class: "badge-title" }, o.kind === "win" ? fill(winBadge.title, vars) : "Won by forfeit"),
        h("p", { class: "badge-msg" }, o.kind === "win" ? fill(winBadge.message, vars) : forfeitWhy))),
    iLost && o.kind === "win" ? h("div", { class: "consolation" },
      medalArt(loseBadge),
      h("div", {},
        h("div", { class: "consolation-title" }, `Your badge: ${fill(loseBadge.title, vars)}`),
        h("p", { class: "badge-msg" }, fill(loseBadge.message, vars)))) : null,
    mySide ? roundActions(store) : null);
}

function roundActions(store: GameStore): HTMLElement {
  return h("div", { class: "actions" },
    h("button", { onclick: () => store.nextRound() }, "Play again"),
    h("button", { class: "secondary", onclick: () => store.swapSides() }, "Swap sides"));
}

function confetti(): HTMLElement {
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

function footer(r: Round, ctx: ViewContext): HTMLElement {
  const items: HTMLElement[] = [];
  if (ctx.onShareToStage) {
    items.push(h("button", { class: "link", onclick: ctx.onShareToStage }, "Show on meeting stage"));
  }
  if (ctx.localTest) {
    items.push(h("span", { class: "muted" }, "Local test: open this exact URL in a second tab to join."));
  }
  if (r.seats.even || r.seats.odd) {
    items.push(h("button", { class: "link", onclick: () => ctx.store.reset() }, "Reset game"));
  }
  return h("footer", {}, items);
}

// ---------- screens outside the game ----------

export function renderMessage(root: HTMLElement, title: string, ...lines: Child[]): void {
  root.replaceChildren(h("div", { class: "panel" }, h("h1", {}, title), lines.map(l => h("p", { class: "muted" }, l))));
}

/** Shown when the public site is opened outside Teams. */
export function renderLanding(root: HTMLElement): void {
  root.replaceChildren(
    h("header", {}, h("h1", {}, "Even or Odd")),
    h("div", { class: "panel landing" },
      h("p", { class: "big" }, "A two-player duel for Microsoft Teams meetings."),
      h("ol", { class: "steps" },
        h("li", {}, "One player takes Even, the other Odd."),
        h("li", {}, "Both lock in a secret number."),
        h("li", {}, "The sum decides: an even sum means Even wins.")),
      h("p", { class: "muted" }, "It runs inside a Teams meeting, so open it from the meeting's Apps menu to play."),
      h("a", { class: "button-link", href: "https://github.com/jureperak/parity-duel" }, "View on GitHub")));
}
