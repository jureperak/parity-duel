// Pure game rules — no DOM, no Live Share, no crypto. Safe to unit test.
//
// Fair play uses commit–reveal: each player first publishes a hash of their
// number (a commitment), and only once both commitments are in does each
// client publish the number itself. Nobody can see the other's number early,
// and nobody can change theirs after seeing the opponent's.

export type Side = "even" | "odd";

export interface Player {
  id: string;
  name: string;
  photo?: string | null;
}

export interface Commit {
  round: number;
  hash: string; // hex SHA-256, see fairplay.ts
}

export interface Reveal {
  round: number;
  value: number;
  salt: string;
}

export type Seats = Partial<Record<Side, Player>>;
export type Commits = Partial<Record<Side, Commit>>;
export type Reveals = Partial<Record<Side, Reveal>>;
/** Result of checking a reveal against its commitment; undefined = not checked yet. */
export type Verdicts = Partial<Record<Side, boolean>>;

export interface Round {
  seats: Seats;
  commits: Commits;
  reveals: Reveals;
  round: number;
}

export type Outcome =
  | { kind: "lobby" }
  | { kind: "picking" }
  | { kind: "revealing"; waitingFor: Side[] }
  | { kind: "win"; winner: Side; loser: Side; sum: number; picks: Record<Side, number> }
  | { kind: "forfeit"; winner: Side; loser: Side; reason: "no-reveal" | "bad-reveal" }
  | { kind: "void"; reason: "no-reveal" | "bad-reveal" };

export const SIDES: readonly Side[] = ["even", "odd"];
export const MAX_DIGITS = 9;
/** How long a player gets to reveal after both have committed. Honest clients reveal instantly. */
export const REVEAL_TIMEOUT_MS = 15_000;

const HASH_RE = /^[0-9a-f]{64}$/;
const SALT_RE = /^[0-9a-f]{32}$/;

export function other(side: Side): Side {
  return side === "even" ? "odd" : "even";
}

/** Returns a positive integer, or null if the input isn't one. */
export function parsePick(input: unknown): number | null {
  const text = (typeof input === "number" ? String(input) : typeof input === "string" ? input : "").trim();
  if (!new RegExp(`^\\d{1,${MAX_DIGITS}}$`).test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

/** Classic odds-and-evens: the parity of the SUM picks the winner. */
export function decide(evenPick: number, oddPick: number): { sum: number; winner: Side; loser: Side } {
  const sum = evenPick + oddPick;
  const winner: Side = sum % 2 === 0 ? "even" : "odd";
  return { sum, winner, loser: other(winner) };
}

/** Which side the given player sits on, or null for spectators. */
export function seatOf(seats: Seats, playerId: string): Side | null {
  return SIDES.find(s => seats[s]?.id === playerId) ?? null;
}

// ---------- validating data that arrives from other clients ----------

export function asCommit(v: unknown): Commit | undefined {
  if (!isRecord(v)) return undefined;
  return Number.isInteger(v.round) && typeof v.hash === "string" && HASH_RE.test(v.hash)
    ? { round: v.round as number, hash: v.hash }
    : undefined;
}

export function asReveal(v: unknown): Reveal | undefined {
  if (!isRecord(v)) return undefined;
  const value = parsePick(v.value);
  return Number.isInteger(v.round) && value !== null && typeof v.salt === "string" && SALT_RE.test(v.salt)
    ? { round: v.round as number, value, salt: v.salt }
    : undefined;
}

export function asPlayer(v: unknown): Player | undefined {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id) return undefined;
  return {
    id: v.id.slice(0, 64),
    name: typeof v.name === "string" ? v.name.slice(0, 64) : "",
    photo: typeof v.photo === "string" ? v.photo : null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------- round resolution ----------

const inRound = <T extends { round: number }>(x: T | undefined, round: number): T | undefined =>
  x?.round === round ? x : undefined;

/**
 * Where the current round stands.
 * @param verdicts  hash checks for the current round's reveals (async, so passed in)
 * @param revealWaitMs  how long both commitments have been in, as seen by this client
 */
export function resolveRound(r: Round, verdicts: Verdicts, revealWaitMs: number): Outcome {
  if (!r.seats.even || !r.seats.odd) return { kind: "lobby" };
  if (!SIDES.every(s => inRound(r.commits[s], r.round))) return { kind: "picking" };

  const reveals = { even: inRound(r.reveals.even, r.round), odd: inRound(r.reveals.odd, r.round) };
  const cheated = SIDES.filter(s => reveals[s] && verdicts[s] === false);
  if (cheated.length === 2) return { kind: "void", reason: "bad-reveal" };
  if (cheated.length === 1) {
    return { kind: "forfeit", winner: other(cheated[0]), loser: cheated[0], reason: "bad-reveal" };
  }

  const confirmed = SIDES.filter(s => reveals[s] && verdicts[s] === true);
  if (confirmed.length === 2) {
    const picks = { even: reveals.even!.value, odd: reveals.odd!.value };
    return { kind: "win", ...decide(picks.even, picks.odd), picks };
  }

  const missing = SIDES.filter(s => !reveals[s]);
  if (revealWaitMs >= REVEAL_TIMEOUT_MS && missing.length > 0) {
    if (missing.length === 2) return { kind: "void", reason: "no-reveal" };
    return { kind: "forfeit", winner: other(missing[0]), loser: missing[0], reason: "no-reveal" };
  }
  // Waiting on reveals that haven't arrived, or on hash checks still running.
  return { kind: "revealing", waitingFor: SIDES.filter(s => !confirmed.includes(s)) };
}

/** Who wins, if the round is decided. */
export function winnerOf(o: Outcome): Side | null {
  return o.kind === "win" || o.kind === "forfeit" ? o.winner : null;
}

// Deterministic so every client in the meeting shows the same badge.
export function badgeIndex(round: number, sum: number, count: number): number {
  return (round * 7 + sum) % count;
}
