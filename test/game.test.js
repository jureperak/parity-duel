import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePick, decide, seatOf, phase, badgeIndex } from "../src/game.js";

test("parsePick accepts positive whole numbers only", () => {
  assert.equal(parsePick("7"), 7);
  assert.equal(parsePick(" 42 "), 42);
  assert.equal(parsePick("999999999"), 999999999);
  for (const bad of ["", "0", "-3", "2.5", "1e3", "abc", "1234567890", null, undefined]) {
    assert.equal(parsePick(bad), null, `rejects ${bad}`);
  }
});

test("decide uses the parity of the sum", () => {
  assert.deepEqual(decide(2, 4), { sum: 6, winner: "even", loser: "odd" });
  assert.deepEqual(decide(3, 5), { sum: 8, winner: "even", loser: "odd" });
  assert.deepEqual(decide(2, 5), { sum: 7, winner: "odd", loser: "even" });
});

test("phase moves lobby -> picking -> reveal per round", () => {
  const seats = { even: { id: "a" }, odd: { id: "b" } };
  assert.equal(phase({ even: seats.even }, {}, 1), "lobby");
  assert.equal(phase(seats, {}, 1), "picking");
  assert.equal(phase(seats, { even: { round: 1, value: 3 } }, 1), "picking");
  const picks = { even: { round: 1, value: 3 }, odd: { round: 1, value: 4 } };
  assert.equal(phase(seats, picks, 1), "reveal");
  assert.equal(phase(seats, picks, 2), "picking", "old-round picks don't count");
});

test("seatOf and badgeIndex", () => {
  const seats = { even: { id: "a" }, odd: { id: "b" } };
  assert.equal(seatOf(seats, "b"), "odd");
  assert.equal(seatOf(seats, "z"), null);
  for (let r = 1; r < 20; r++) {
    const i = badgeIndex(r, r * 3, 4);
    assert.ok(i >= 0 && i < 4);
  }
});
