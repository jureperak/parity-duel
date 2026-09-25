import { test } from "node:test";
import assert from "node:assert/strict";
import { safePhoto, initials, avatarColor } from "../src/identity.ts";

test("safePhoto only accepts small inline jpeg/png data URLs", () => {
  const ok = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(safePhoto(ok), ok);
  assert.equal(safePhoto("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  for (const bad of [
    "https://evil.example/x.jpg",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    'data:image/png;base64,AAA" onerror="alert(1)',
    "data:image/png;base64," + "A".repeat(40_000),
    null, 42, {},
  ]) assert.equal(safePhoto(bad), null, `rejects ${JSON.stringify(bad)?.slice(0, 40)}`);
});

test("initials", () => {
  assert.equal(initials("Jure Perak"), "JP");
  assert.equal(initials("Ana Marija Horvat"), "AH");
  assert.equal(initials("ana"), "AN");
  assert.equal(initials(""), "?");
  assert.equal(initials(undefined), "?");
});

test("avatarColor is stable per name", () => {
  assert.equal(avatarColor("Ana"), avatarColor("Ana"));
  assert.match(avatarColor("Jure"), /^#[0-9a-f]{6}$/);
});
