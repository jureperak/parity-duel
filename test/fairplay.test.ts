import { test } from "node:test";
import assert from "node:assert/strict";
import { newSalt, commitHash, verifyReveal } from "../src/fairplay.ts";
import { asCommit, asReveal } from "../src/game.ts";
import { isLocalHost } from "../src/env.ts";

test("salts are 128-bit hex and unique", () => {
  const a = newSalt(), b = newSalt();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("commitments are deterministic and valid wire data", async () => {
  const salt = newSalt();
  const h1 = await commitHash(3, "even", 42, salt);
  assert.equal(h1, await commitHash(3, "even", 42, salt));
  assert.ok(asCommit({ round: 3, hash: h1 }), "hash passes the wire validator");
  assert.ok(asReveal({ round: 3, value: 42, salt }), "salt passes the wire validator");
});

test("a commitment binds value, salt, round and side", async () => {
  const salt = newSalt();
  const hash = await commitHash(1, "odd", 7, salt);
  const commit = { round: 1, hash };
  assert.equal(await verifyReveal(commit, { round: 1, value: 7, salt }, "odd"), true);
  assert.equal(await verifyReveal(commit, { round: 1, value: 8, salt }, "odd"), false, "changed number");
  assert.equal(await verifyReveal(commit, { round: 1, value: 7, salt: newSalt() }, "odd"), false, "changed salt");
  assert.equal(await verifyReveal(commit, { round: 1, value: 7, salt }, "even"), false, "other seat");
  assert.equal(await verifyReveal({ round: 2, hash }, { round: 2, value: 7, salt }, "odd"), false, "other round");
});

test("local test mode only on the developer's machine", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(isLocalHost(host), true, host);
  for (const host of ["jureperak.github.io", "localhost.evil.com", "192.168.1.5"]) assert.equal(isLocalHost(host), false, host);
});
