import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePick, decide, seatOf, badgeIndex, resolveRound, winnerOf, asCommit, asReveal, asPlayer,
  REVEAL_TIMEOUT_MS,
} from "../src/game.ts";
import type { Round, Verdicts } from "../src/game.ts";

const H = (c: string) => c.repeat(64);  // a well-formed fake hash
const SALT = "a".repeat(32);

const seated = { even: { id: "a", name: "Ana" }, odd: { id: "b", name: "Bo" } };
const committed = { even: { round: 1, hash: H("1") }, odd: { round: 1, hash: H("2") } };
const revealed = { even: { round: 1, value: 3, salt: SALT }, odd: { round: 1, value: 4, salt: SALT } };
const round = (over: Partial<Round> = {}): Round =>
  ({ seats: seated, commits: committed, reveals: revealed, round: 1, ...over });
const both: Verdicts = { even: true, odd: true };

test("parsePick accepts single digits 0-9 only", () => {
  for (let d = 0; d <= 9; d++) {
    assert.equal(parsePick(d), d);
    assert.equal(parsePick(String(d)), d);
  }
  assert.equal(parsePick(" 7 "), 7);
  for (const bad of ["", "10", "-1", "2.5", "1e0", "abc", "٣", 10, -1, 2.5, NaN, null, undefined]) {
    assert.equal(parsePick(bad), null, `rejects ${String(bad)}`);
  }
});

test("decide uses the parity of the sum", () => {
  assert.deepEqual(decide(2, 4), { sum: 6, winner: "even", loser: "odd" });
  assert.deepEqual(decide(3, 5), { sum: 8, winner: "even", loser: "odd" });
  assert.deepEqual(decide(2, 5), { sum: 7, winner: "odd", loser: "even" });
});

test("lobby until both seats are taken", () => {
  assert.equal(resolveRound(round({ seats: { even: seated.even } }), both, 0).kind, "lobby");
});

test("picking until both players have committed for this round", () => {
  assert.equal(resolveRound(round({ commits: {}, reveals: {} }), {}, 0).kind, "picking");
  assert.equal(resolveRound(round({ commits: { even: committed.even }, reveals: {} }), {}, 0).kind, "picking");
  assert.equal(resolveRound(round({ round: 2 }), both, 0).kind, "picking", "last round's commits don't count");
});

test("revealing while reveals or their checks are outstanding", () => {
  const o = resolveRound(round({ reveals: { even: revealed.even } }), { even: true }, 1000);
  assert.deepEqual(o, { kind: "revealing", waitingFor: ["odd"] });
  const pendingCheck = resolveRound(round(), { even: true }, 1000);
  assert.deepEqual(pendingCheck, { kind: "revealing", waitingFor: ["odd"] });
});

test("both verified reveals decide the round by the sum", () => {
  const o = resolveRound(round(), both, 0);
  assert.deepEqual(o, { kind: "win", winner: "odd", loser: "even", sum: 7, picks: { even: 3, odd: 4 } });
  assert.equal(winnerOf(o), "odd");
});

test("a reveal that doesn't match its commitment forfeits", () => {
  const o = resolveRound(round(), { even: false, odd: true }, 0);
  assert.deepEqual(o, { kind: "forfeit", winner: "odd", loser: "even", reason: "bad-reveal" });
  assert.deepEqual(resolveRound(round(), { even: false, odd: false }, 0), { kind: "void", reason: "bad-reveal" });
});

test("not revealing in time forfeits, and only after the timeout", () => {
  const r = round({ reveals: { odd: revealed.odd } });
  assert.equal(resolveRound(r, { odd: true }, REVEAL_TIMEOUT_MS - 1).kind, "revealing");
  assert.deepEqual(resolveRound(r, { odd: true }, REVEAL_TIMEOUT_MS),
    { kind: "forfeit", winner: "odd", loser: "even", reason: "no-reveal" });
  assert.deepEqual(resolveRound(round({ reveals: {} }), {}, REVEAL_TIMEOUT_MS),
    { kind: "void", reason: "no-reveal" });
});

test("remote data is validated before use", () => {
  assert.deepEqual(asCommit({ round: 1, hash: H("f") }), { round: 1, hash: H("f") });
  assert.equal(asCommit({ round: 1, hash: "nothex" }), undefined);
  assert.equal(asCommit({ round: "1", hash: H("f") }), undefined);
  assert.equal(asCommit(null), undefined);

  assert.deepEqual(asReveal({ round: 2, value: 5, salt: SALT }), { round: 2, value: 5, salt: SALT });
  assert.deepEqual(asReveal({ round: 2, value: 0, salt: SALT }), { round: 2, value: 0, salt: SALT }, "0 is a valid pick");
  assert.equal(asReveal({ round: 2, value: 12, salt: SALT }), undefined, "no multi-digit picks");
  assert.equal(asReveal({ round: 2, value: -5, salt: SALT }), undefined);
  assert.equal(asReveal({ round: 2, value: 5, salt: "short" }), undefined);

  assert.deepEqual(asPlayer({ id: "x", name: "N".repeat(100) }), { id: "x", name: "N".repeat(64), photo: null });
  assert.equal(asPlayer({ name: "no id" }), undefined);
  assert.equal(asPlayer("string"), undefined);
});

test("seatOf and badgeIndex", () => {
  assert.equal(seatOf(seated, "b"), "odd");
  assert.equal(seatOf(seated, "z"), null);
  for (let r = 1; r < 20; r++) {
    const i = badgeIndex(r, r * 3, 4);
    assert.ok(i >= 0 && i < 4);
  }
});
