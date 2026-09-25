import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, parseMessage, applyOps, encode, MAX_MESSAGE_CHARS } from "../src/protocol.ts";
import type { Op, RefereeView } from "../src/protocol.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003"; // spectator
const player = (id: string, name = "P") => ({ id, name, photo: null });
const HASH = "f".repeat(64);
const SALT = "a".repeat(32);

function view(entries: Record<string, unknown>, offline: string[] = []): RefereeView {
  const m = new Map(Object.entries(entries));
  return { get: k => m.get(k), isOnline: id => !offline.includes(id) };
}
const bothSeated = { "seat:even": player(A), "seat:odd": player(B), round: 3 };

test("anyone may take a free seat, but not a taken one", () => {
  assert.equal(authorize([{ key: "seat:even", value: player(C) }], C, view({})), null);
  assert.equal(authorize([{ key: "seat:even", value: player(C) }], C, view(bothSeated)), "seat is taken");
});

test("a seat whose player left can be taken over, starting a new round", () => {
  const ops: Op[] = [{ key: "seat:odd", value: player(C) }, { key: "round", value: 4 }];
  assert.equal(authorize(ops, C, view(bothSeated, [B])), null);
});

test("nobody can sit on both sides", () => {
  assert.equal(authorize([{ key: "seat:odd", value: player(A) }], A, view({ "seat:even": player(A) })),
    "already seated on the other side");
  assert.notEqual(authorize([{ key: "seat:odd", value: player(A) }], A, view(bothSeated)), null,
    "can't grab the opponent's seat either");
});

test("players can refresh their own seat (name or photo change)", () => {
  assert.equal(authorize([{ key: "seat:even", value: player(A, "New name") }], A, view(bothSeated)), null);
});

test("seated players can swap sides; spectators can't move anyone", () => {
  const swap: Op[] = [
    { key: "seat:even", value: player(B) }, { key: "seat:odd", value: player(A) }, { key: "round", value: 4 },
  ];
  assert.equal(authorize(swap, A, view(bothSeated)), null);
  assert.equal(authorize(swap, C, view(bothSeated)), "can't seat another player");
  assert.equal(authorize([{ key: "seat:even", value: player(C) }], A, view(bothSeated)), "can't seat another player",
    "a player can't seat a stranger");
});

test("commits and reveals only for your own seat", () => {
  const commit = { round: 3, hash: HASH };
  assert.equal(authorize([{ key: "commit:even", value: commit }], A, view(bothSeated)), null);
  assert.equal(authorize([{ key: "commit:odd", value: commit }], A, view(bothSeated)), "can only commit for your own seat");
  assert.equal(authorize([{ key: "reveal:odd", value: { round: 3, value: 5, salt: SALT } }], C, view(bothSeated)),
    "can only reveal for your own seat");
  assert.equal(authorize([{ key: "commit:even", value: { round: 3, hash: "x" } }], A, view(bothSeated)), "invalid commit");
});

test("rounds only advance by one, and only players advance them", () => {
  assert.equal(authorize([{ key: "round", value: 4 }], A, view(bothSeated)), null);
  assert.equal(authorize([{ key: "round", value: 9 }], A, view(bothSeated)), "invalid round change");
  assert.equal(authorize([{ key: "round", value: 4 }], C, view(bothSeated)), "invalid round change");
});

test("leaving and resetting are allowed for seated players only", () => {
  const leave: Op[] = [
    { key: "seat:even", delete: true }, { key: "commit:even", delete: true }, { key: "reveal:even", delete: true },
  ];
  assert.equal(authorize(leave, A, view(bothSeated)), null);
  const reset: Op[] = [
    ...["seat", "commit", "reveal"].flatMap(k => ["even", "odd"].map(s => ({ key: `${k}:${s}`, delete: true as const }))),
    { key: "round", value: 1 },
  ];
  assert.equal(authorize(reset, A, view(bothSeated)), null);
  assert.notEqual(authorize(reset, C, view(bothSeated)), null, "spectators can't reset");
});

test("unknown keys are rejected", () => {
  assert.equal(authorize([{ key: "__proto__", value: 1 }], A, view(bothSeated)), "unknown key");
});

test("parseMessage accepts only well-formed messages", () => {
  const ops: Op[] = [{ key: "round", value: 2 }];
  assert.deepEqual(parseMessage(encode({ v: 1, t: "ops", ops })), { v: 1, t: "ops", ops });
  assert.deepEqual(parseMessage(encode({ v: 1, t: "hello", playerId: A })), { v: 1, t: "hello", playerId: A });
  for (const bad of [
    "not json", "{}", JSON.stringify({ v: 2, t: "hello", playerId: A }),
    JSON.stringify({ v: 1, t: "hello", playerId: "<script>" }),
    JSON.stringify({ v: 1, t: "ops", ops: [{ key: "evil", value: 1 }] }),
    JSON.stringify({ v: 1, t: "ops", ops: Array(20).fill({ key: "round", value: 2 }) }),
    "x".repeat(MAX_MESSAGE_CHARS + 1), 42, null,
  ]) assert.equal(parseMessage(bad), null, `rejects ${String(bad).slice(0, 40)}`);
});

test("applyOps sets and deletes", () => {
  const m = new Map<string, unknown>([["round", 1], ["seat:even", player(A)]]);
  applyOps(m, [{ key: "round", value: 2 }, { key: "seat:even", delete: true }]);
  assert.deepEqual([...m], [["round", 2]]);
});
