// Shared game state on a Fluid SharedMap, plus everything the UI needs to know
// about it: validated snapshots, fair-play verification, and who is online.
//
// Keys in the map:
//   seat:<side>    Player          who sits on Even / Odd
//   commit:<side>  Commit          hash of this round's pick
//   reveal:<side>  Reveal          the pick itself, published after both commits
//   round          number          current round, starts at 1
import type { SharedMap } from "fluid-framework";
import type { LivePresence } from "@microsoft/live-share";
import { PresenceState } from "@microsoft/live-share";
import {
  SIDES, seatOf, asCommit, asReveal, asPlayer, resolveRound, REVEAL_TIMEOUT_MS,
} from "./game.ts";
import type { Side, Player, Round, Outcome, Verdicts, Commit, Reveal } from "./game.ts";
import { newSalt, commitHash, verifyReveal } from "./fairplay.ts";

export interface PresenceData {
  playerId: string;
}

export interface Me {
  id: string;
  name: string;
  photo: string | null;
  fromTeams: boolean;
}

/** A pick we committed to but haven't revealed yet. Kept in sessionStorage so a reload can still reveal. */
interface Secret {
  round: number;
  side: Side;
  value: number;
  salt: string;
  hash: string;
}

const SECRET_KEY = "eo-secret";
/** Presence needs a moment after joining before "not seen" can safely mean "offline". */
const PRESENCE_SETTLE_MS = 5_000;
/**
 * Live Share works out "offline" lazily when presence is read and emits no event
 * when someone times out, so re-check on a timer to notice players who left.
 */
const PRESENCE_RECHECK_MS = 5_000;

export class GameStore {
  private verdicts = new Map<string, boolean>();
  private checking = new Set<string>();
  private bothCommittedSince = new Map<string, number>();
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceSettled = false;
  private secret: Secret | null = loadSecret();

  private readonly map: SharedMap;
  private readonly presence: LivePresence<PresenceData>;
  readonly me: Me;
  private readonly onChange: () => void;

  constructor(map: SharedMap, presence: LivePresence<PresenceData>, me: Me, onChange: () => void) {
    this.map = map;
    this.presence = presence;
    this.me = me;
    this.onChange = onChange;
  }

  /** Call once after the presence object is initialized. */
  start(): void {
    this.map.on("valueChanged", () => this.changed());
    this.presence.on("presenceChanged", () => this.onChange());
    setTimeout(() => { this.presenceSettled = true; this.onChange(); }, PRESENCE_SETTLE_MS);
    setInterval(() => this.onChange(), PRESENCE_RECHECK_MS);
    this.changed();
  }

  // ---------- reading ----------

  snapshot(): Round {
    const seats = { even: asPlayer(this.map.get("seat:even")), odd: asPlayer(this.map.get("seat:odd")) };
    const commits = { even: asCommit(this.map.get("commit:even")), odd: asCommit(this.map.get("commit:odd")) };
    const reveals = { even: asReveal(this.map.get("reveal:even")), odd: asReveal(this.map.get("reveal:odd")) };
    const round = this.map.get<number>("round");
    return { seats, commits, reveals, round: Number.isInteger(round) && round! > 0 ? round! : 1 };
  }

  outcome(r: Round = this.snapshot()): Outcome {
    const verdicts: Verdicts = {};
    for (const s of SIDES) {
      const key = verdictKey(r, s);
      if (key) verdicts[s] = this.verdicts.get(key);
    }
    return resolveRound(r, verdicts, this.revealWaitMs(r));
  }

  mySide(r: Round = this.snapshot()): Side | null {
    return seatOf(r.seats, this.me.id);
  }

  /** The pick I committed to this round, if any (only I know it until the reveal). */
  myPendingPick(r: Round = this.snapshot()): number | null {
    const side = this.mySide(r);
    const s = this.secret;
    return s && side && s.side === side && s.round === r.round && r.commits[side]?.hash === s.hash ? s.value : null;
  }

  /** False only when we're confident the seated player has left. */
  isOnline(player: Player | undefined): boolean {
    if (!player) return false;
    if (player.id === this.me.id || !this.presenceSettled) return true;
    return this.onlinePlayerIds().has(player.id);
  }

  private onlinePlayerIds(): Set<string> {
    const ids = new Set<string>();
    for (const user of this.presence.getUsers(PresenceState.online)) {
      for (const c of user.getConnections(PresenceState.online)) {
        if (c.data?.playerId) ids.add(c.data.playerId);
      }
    }
    return ids;
  }

  // ---------- actions ----------

  /** Take a side if it's free, or if the player there has left. */
  sit(side: Side): void {
    const r = this.snapshot();
    const current = r.seats[side];
    if (current && current.id !== this.me.id && this.isOnline(current)) return;
    if (this.mySide(r)) return;
    this.map.set(`seat:${side}`, this.seatData(side));
    // A new player starts a fresh round, so nobody inherits a half-played one.
    if (current) this.map.set("round", r.round + 1);
  }

  leave(): void {
    const side = this.mySide();
    if (!side) return;
    for (const k of [`seat:${side}`, `commit:${side}`, `reveal:${side}`]) this.map.delete(k);
    this.setSecret(null);
  }

  async lockIn(value: number): Promise<void> {
    const r = this.snapshot();
    const side = this.mySide(r);
    if (!side || r.commits[side]?.round === r.round) return;
    const salt = newSalt();
    const hash = await commitHash(r.round, side, value, salt);
    this.setSecret({ round: r.round, side, value, salt, hash });
    this.map.set(`commit:${side}`, { round: r.round, hash } satisfies Commit);
  }

  nextRound(): void {
    this.map.set("round", this.snapshot().round + 1);
  }

  swapSides(): void {
    const r = this.snapshot();
    this.map.set("seat:even", r.seats.odd);
    this.map.set("seat:odd", r.seats.even);
    this.map.set("round", r.round + 1);
  }

  reset(): void {
    for (const s of SIDES) for (const k of ["seat", "commit", "reveal"]) this.map.delete(`${k}:${s}`);
    this.map.set("round", 1);
    this.setSecret(null);
  }

  /** Re-publish my seat after my name or photo changed. */
  refreshMySeat(): void {
    const side = this.mySide();
    if (side) this.map.set(`seat:${side}`, this.seatData(side));
  }

  // ---------- internals ----------

  private seatData(side: Side): Player {
    return { id: this.me.id, name: this.me.name || `${side === "even" ? "Even" : "Odd"} player`, photo: this.me.photo };
  }

  private changed(): void {
    const r = this.snapshot();
    this.revealIfDue(r);
    this.verifyReveals(r);
    this.scheduleRevealTimeout(r);
    this.onChange();
  }

  /** Publish my number once both commitments for this round are in. */
  private revealIfDue(r: Round): void {
    const side = this.mySide(r);
    const s = this.secret;
    if (!side || !s || s.side !== side || s.round !== r.round) return;
    if (!SIDES.every(x => r.commits[x]?.round === r.round)) return;
    if (r.commits[side]?.hash !== s.hash || r.reveals[side]?.round === r.round) return;
    this.map.set(`reveal:${side}`, { round: s.round, value: s.value, salt: s.salt } satisfies Reveal);
  }

  /** Check each reveal against its commitment (async), then re-render with the verdict. */
  private verifyReveals(r: Round): void {
    for (const side of SIDES) {
      const key = verdictKey(r, side);
      if (!key || this.verdicts.has(key) || this.checking.has(key)) continue;
      this.checking.add(key);
      verifyReveal(r.commits[side]!, r.reveals[side]!, side)
        .then(ok => this.verdicts.set(key, ok))
        .catch(() => this.verdicts.set(key, false))
        .finally(() => { this.checking.delete(key); this.onChange(); });
    }
  }

  private revealWaitMs(r: Round): number {
    const key = commitsKey(r);
    const since = key ? this.bothCommittedSince.get(key) : undefined;
    return since === undefined ? 0 : Date.now() - since;
  }

  /** Start the reveal clock when both commitments appear, and re-render when it runs out. */
  private scheduleRevealTimeout(r: Round): void {
    const key = commitsKey(r);
    if (!key) return;
    if (!this.bothCommittedSince.has(key)) {
      this.bothCommittedSince.set(key, Date.now());
      clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => this.onChange(), REVEAL_TIMEOUT_MS + 50);
    }
  }

  private setSecret(s: Secret | null): void {
    this.secret = s;
    try {
      if (s) sessionStorage.setItem(SECRET_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SECRET_KEY);
    } catch { /* storage unavailable: reveal still works until reload */ }
  }
}

/** Identifies one (commit, reveal) pair, so a verdict is never reused for different data. */
function verdictKey(r: Round, side: Side): string | null {
  const c = r.commits[side], v = r.reveals[side];
  if (c?.round !== r.round || v?.round !== r.round) return null;
  return `${side}:${r.round}:${c.hash}:${v.value}:${v.salt}`;
}

function commitsKey(r: Round): string | null {
  const e = r.commits.even, o = r.commits.odd;
  return e?.round === r.round && o?.round === r.round ? `${r.round}:${e.hash}:${o.hash}` : null;
}

function loadSecret(): Secret | null {
  try {
    const raw = sessionStorage.getItem(SECRET_KEY);
    const s = raw ? JSON.parse(raw) as Secret : null;
    return s && typeof s.hash === "string" && (s.side === "even" || s.side === "odd") ? s : null;
  } catch {
    return null;
  }
}

