// Pure game rules — no DOM, no Live Share. Safe to unit test.

export const SIDES = ["even", "odd"];
export const MAX_DIGITS = 9;

export function other(side) {
  return side === "even" ? "odd" : "even";
}

/** Returns a positive integer, or null if the input isn't one. */
export function parsePick(input) {
  const text = String(input ?? "").trim();
  if (!new RegExp(`^\\d{1,${MAX_DIGITS}}$`).test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

/** Classic odds-and-evens: the parity of the SUM picks the winner. */
export function decide(evenPick, oddPick) {
  const sum = evenPick + oddPick;
  const winner = sum % 2 === 0 ? "even" : "odd";
  return { sum, winner, loser: other(winner) };
}

/** Which side the given player sits on, or null for spectators. */
export function seatOf(seats, playerId) {
  return SIDES.find(s => seats[s]?.id === playerId) ?? null;
}

/**
 * Phase of the current round:
 *  - "lobby":   a seat is still empty
 *  - "picking": both seated, at least one pick missing for this round
 *  - "reveal":  both picks are in for this round
 */
export function phase(seats, picks, round) {
  if (!seats.even || !seats.odd) return "lobby";
  const ready = SIDES.every(s => picks[s]?.round === round);
  return ready ? "reveal" : "picking";
}

// Deterministic so every client in the meeting shows the same badge.
export function badgeIndex(round, sum, count) {
  return (round * 7 + sum) % count;
}
