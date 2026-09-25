// Rendering. Everything is rebuilt from the store on each change; the only
// local UI state is the number being typed and the nickname field.
import { h, cap } from "./dom.ts";
import type { Child } from "./dom.ts";
import { SIDES, other, parsePick, badgeIndex, winnerOf, MIN_PICK, MAX_PICK } from "./game.ts";
import type { Side, Round, Outcome } from "./game.ts";
import { WIN_BADGES, LOSE_BADGES, fill } from "./badges.ts";
import type { Badge, BadgeVars } from "./badges.ts";
import { avatar } from "./identity.ts";
import type { GameStore } from "./store.ts";
import type { ConnectionStatus } from "./sync.ts";
import { shareBadge, prepareBadge, isTouchDevice, NO_CAPTURE } from "./share.ts";
import type { ShareResult } from "./share.ts";

export interface ViewContext {
  store: GameStore;
  status: ConnectionStatus;
  /** Link that lets someone else join this game (browser games only). */
  inviteUrl?: string;
  /** Present only in the Teams side panel. */
  onShareToStage?: () => void;
  onNewGame?: () => void;
}

let draft: number | null = null; // digit selected but not locked in yet
let renameTimer: ReturnType<typeof setTimeout> | undefined;

let lastSignature = "";

/**
 * Everything the game screen depends on. Presence is re-checked on a timer, so
 * most calls change nothing; skipping those keeps animations from replaying and
 * buttons from being swapped out mid-click.
 */
function signature(ctx: ViewContext): string {
  const { store } = ctx;
  const r = store.snapshot();
  return JSON.stringify([
    r, store.outcome(r), store.myPendingPick(r), store.mySide(r),
    store.isOnline(r.seats.even), store.isOnline(r.seats.odd), ctx.status, !!ctx.inviteUrl,
  ]);
}

export function renderGame(root: HTMLElement, ctx: ViewContext): void {
  const sig = signature(ctx);
  if (sig === lastSignature && root.hasChildNodes()) return;
  lastSignature = sig;

  // Remote updates rebuild the page; keep the caret where the user was typing.
  const active = document.activeElement;
  const focus = active instanceof HTMLInputElement && active.id
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
    : null;

  const { store } = ctx;
  const r = store.snapshot();
  const outcome = store.outcome(r);
  const mySide = store.mySide(r);

  const banner = ctx.status === "connected" ? [] : [statusBanner(ctx)];
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

function statusBanner(ctx: ViewContext): HTMLElement {
  if (ctx.status === "host-left") {
    return h("div", { class: "banner", role: "alert" },
      h("p", {}, "The host has left, so this game can't continue. It resumes if they come back."),
      ctx.onNewGame ? h("button", { onclick: ctx.onNewGame }, "Start a new game") : null);
  }
  return h("div", { class: "banner", role: "alert" }, "Connection lost. Reconnecting…");
}

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

  const lock = h("button", { type: "submit", class: "lock", disabled: draft === null }, "Lock in");
  const digits = Array.from({ length: MAX_PICK - MIN_PICK + 1 }, (_, i) => {
    const d = MIN_PICK + i;
    const b = h("button", {
      type: "button", class: "digit", role: "radio", "data-digit": d,
      "aria-checked": draft === d ? "true" : "false",
      onclick: () => select(d),
    }, d);
    return b;
  });
  // Selecting updates the pad in place, so a re-render isn't needed (or lost).
  function select(d: number): void {
    draft = d;
    for (const b of digits) b.setAttribute("aria-checked", b.dataset.digit === String(d) ? "true" : "false");
    lock.disabled = false;
  }
  const submit = (e: Event) => {
    e.preventDefault();
    const n = parsePick(draft);
    if (n === null) return;
    lock.disabled = true;
    draft = null;
    store.lockIn(n).catch((err: unknown) => {
      console.error("Lock in failed", err);
      lock.disabled = false;
    });
  };
  return h("form", { class: "panel picking", onsubmit: submit },
    h("p", { id: "pick-label" }, `You're ${cap(mySide)}. Pick a number:`),
    h("div", { class: "digit-pad", role: "radiogroup", "aria-labelledby": "pick-label" }, digits),
    lock,
    opponentGone,
    chips);
}

// Desktop shortcut: number keys pick, Enter locks in.
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  const pad = document.querySelector(".digit-pad");
  if (!pad) return;
  if (/^[0-9]$/.test(e.key)) {
    pad.querySelector<HTMLButtonElement>(`[data-digit="${e.key}"]`)?.click();
  } else if (e.key === "Enter") {
    const lock = document.querySelector<HTMLButtonElement>(".picking .lock");
    if (lock && !lock.disabled) { e.preventDefault(); lock.click(); }
  }
});

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

  const card: HTMLDivElement = h("div", { class: `panel reveal ${iLost ? "lost" : "won"}` },
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
    shareBadgeButton(() => card, JSON.stringify([r.round, o, mySide]), `even-or-odd-round-${r.round}.png`),
    mySide ? roundActions(store) : null);
  // The image is prepared in the background so a tap can share it instantly (see share.ts).
  prepareBadge(JSON.stringify([r.round, o, mySide]), card);
  return card;
}

const SHARE_LABELS: Record<ShareResult, string | null> = {
  copied: "Copied ✓ Paste it in a chat",
  shared: "Shared ✓",
  cancelled: null, // closed the share sheet: just reset
  downloaded: "Saved as image ✓",
};

function shareBadgeButton(card: () => HTMLElement, key: string, fileName: string): HTMLElement {
  const label = isTouchDevice() ? "Share badge" : "Copy badge";
  const button = h("button", { type: "button", class: `secondary copy-badge ${NO_CAPTURE}` }, label);
  const reset = (): void => { button.textContent = label; button.disabled = false; };
  button.addEventListener("click", () => {
    button.disabled = true;
    shareBadge(key, card(), fileName)
      .then(result => {
        const done = SHARE_LABELS[result];
        if (!done) return reset();
        button.textContent = done;
        setTimeout(reset, 2500);
      })
      .catch((err: unknown) => {
        console.error("Sharing the badge failed", err);
        button.textContent = "Couldn't share. Try again";
        setTimeout(reset, 2500);
      });
  });
  return button;
}

function roundActions(store: GameStore): HTMLElement {
  return h("div", { class: `actions ${NO_CAPTURE}` },
    h("button", { onclick: () => store.nextRound() }, "Play again"),
    h("button", { class: "secondary", onclick: () => store.swapSides() }, "Swap sides"));
}

function confetti(): HTMLElement {
  const colors = ["#ff4a2b", "#ff7a3d", "#e02a73", "#8a3dff", "#b67bff", "#ffd35c"];
  return h("div", { class: `confetti ${NO_CAPTURE}`, "aria-hidden": "true" },
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
  if (ctx.inviteUrl) items.push(inviteButton(ctx.inviteUrl));
  if (ctx.store.mySide(r)) {
    items.push(h("button", { class: "link", onclick: () => ctx.store.reset() }, "Reset game"));
  }
  return h("footer", {}, items);
}

function inviteButton(url: string): HTMLElement {
  const button = h("button", { class: "secondary invite" }, "Copy invite link");
  button.addEventListener("click", () => {
    const done = (label: string): void => {
      button.textContent = label;
      setTimeout(() => { button.textContent = "Copy invite link"; }, 2000);
    };
    navigator.clipboard.writeText(url).then(() => done("Link copied ✓"), () => {
      // Clipboard can be blocked (e.g. inside iframes): show the link so it can be copied by hand.
      window.prompt("Copy this link and send it to your opponent:", url);
    });
  });
  return button;
}

// ---------- screens outside the game ----------

export function renderMessage(root: HTMLElement, title: string, ...lines: Child[]): void {
  root.replaceChildren(h("div", { class: "panel" }, h("h1", {}, title), lines.map(l => h("p", { class: "muted" }, l))));
}

/** First screen in the browser: start a game, then share the link. */
export function renderStart(root: HTMLElement, onNewGame: () => void): void {
  root.replaceChildren(
    h("header", {}, h("h1", {}, "Even or Odd")),
    h("div", { class: "panel landing" },
      h("p", { class: "big" }, "A two-player duel. Choose a side, secretly pick a number from 0 to 9, and let the sum decide."),
      h("ol", { class: "steps" },
        h("li", {}, "Start a game and send the invite link to a friend."),
        h("li", {}, "One of you takes Even, the other Odd."),
        h("li", {}, "Both secretly pick 0–9. An even sum means Even wins.")),
      h("button", { class: "cta", onclick: onNewGame }, "New game"),
      h("p", { class: "fine" },
        "The game runs directly between your browsers. Numbers stay sealed until both players have locked in.")));
}
