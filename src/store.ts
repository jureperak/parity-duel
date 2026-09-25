// Game state on top of any sync backend (see sync.ts), plus everything the UI
// needs to know about it: validated snapshots, fair-play verification, and who
// is online. Every action is sent as one atomic batch of operations.
//
// Keys:
//   seat:<side>    Player          who sits on Even / Odd
//   commit:<side>  Commit          hash of this round's pick
//   reveal:<side>  Reveal          the pick itself, published after both commits
//   round          number          current round, starts at 1
import {
  SIDES, seatOf, asCommit, asReveal, asPlayer, resolveRound, REVEAL_TIMEOUT_MS,
} from "./game.ts";
import type { Side, Player, Round, Outcome, Verdicts, Commit, Reveal } from "./game.ts";
import { newSalt, commitHash, verifyReveal } from "./fairplay.ts";
import type { Op } from "./protocol.ts";
import type { SharedState, Presence } from "./sync.ts";

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

export class GameStore {
  private verdicts = new Map<string, boolean>();
  private checking = new Set<string>();
  private bothCommittedSince = new Map<string, number>();
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private secret: Secret | null = loadSecret();
  /** The reveal already sent, so it isn't re-sent while it travels to the host. */
  private revealSent: string | null = null;

  private readonly state: SharedState;
  private readonly presence: Presence;
  readonly me: Me;
  private readonly onChange: () => void;

  constructor(state: SharedState, presence: Presence, me: Me, onChange: () => void) {
    this.state = state;
    this.presence = presence;
    this.me = me;
    this.onChange = onChange;
  }

  start(): void {
    this.state.subscribe(() => this.changed());
    this.presence.subscribe(() => this.onChange());
    this.changed();
  }

  // ---------- reading ----------

  snapshot(): Round {
    const get = (k: string): unknown => this.state.get(k);
    const seats = { even: asPlayer(get("seat:even")), odd: asPlayer(get("seat:odd")) };
    const commits = { even: asCommit(get("commit:even")), odd: asCommit(get("commit:odd")) };
    const reveals = { even: asReveal(get("reveal:even")), odd: asReveal(get("reveal:odd")) };
    const round = get("round");
    return {
      seats, commits, reveals,
      round: typeof round === "number" && Number.isInteger(round) && round > 0 ? round : 1,
    };
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
    if (player.id === this.me.id || !this.presence.settled()) return true;
    return this.presence.onlinePlayerIds().has(player.id);
  }

  // ---------- actions ----------

  /** Take a side if it's free, or if the player there has left. */
  sit(side: Side): void {
    const r = this.snapshot();
    const current = r.seats[side];
    if (current && current.id !== this.me.id && this.isOnline(current)) return;
    if (this.mySide(r)) return;
    const ops: Op[] = [{ key: `seat:${side}`, value: this.seatData(side) }];
    // A new player starts a fresh round, so nobody inherits a half-played one.
    if (current) ops.push({ key: "round", value: r.round + 1 });
    this.state.apply(ops);
  }

  leave(): void {
    const side = this.mySide();
    if (!side) return;
    this.state.apply([`seat:${side}`, `commit:${side}`, `reveal:${side}`].map(key => ({ key, delete: true as const })));
    this.setSecret(null);
  }

  async lockIn(value: number): Promise<void> {
    const r = this.snapshot();
    const side = this.mySide(r);
    if (!side || r.commits[side]?.round === r.round) return;
    const salt = newSalt();
    const hash = await commitHash(r.round, side, value, salt);
    this.setSecret({ round: r.round, side, value, salt, hash });
    this.state.apply([{ key: `commit:${side}`, value: { round: r.round, hash } satisfies Commit }]);
  }

  nextRound(): void {
    this.state.apply([{ key: "round", value: this.snapshot().round + 1 }]);
  }

  swapSides(): void {
    const r = this.snapshot();
    this.state.apply([
      { key: "seat:even", value: r.seats.odd },
      { key: "seat:odd", value: r.seats.even },
      { key: "round", value: r.round + 1 },
    ]);
  }

  reset(): void {
    const clear: Op[] = SIDES.flatMap(s =>
      ["seat", "commit", "reveal"].map(k => ({ key: `${k}:${s}`, delete: true as const })));
    this.state.apply([...clear, { key: "round", value: 1 }]);
    this.setSecret(null);
  }

  /** Re-publish my seat after my name or photo changed. */
  refreshMySeat(): void {
    const side = this.mySide();
    if (side) this.state.apply([{ key: `seat:${side}`, value: this.seatData(side) }]);
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
    if (this.revealSent === s.hash) return;
    this.revealSent = s.hash;
    this.state.apply([{ key: `reveal:${side}`, value: { round: s.round, value: s.value, salt: s.salt } satisfies Reveal }]);
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

