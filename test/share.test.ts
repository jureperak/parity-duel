import { test } from "node:test";
import assert from "node:assert/strict";
import { shareOrder } from "../src/share.ts";

test("phones share first: most mobile chat apps can't paste images", () => {
  assert.deepEqual(shareOrder({ touch: true, canShareFiles: true, canCopyImage: true }),
    ["share", "clipboard", "download"]);
});

test("computers copy first, then share, then download", () => {
  assert.deepEqual(shareOrder({ touch: false, canShareFiles: true, canCopyImage: true }),
    ["clipboard", "share", "download"]);
  assert.deepEqual(shareOrder({ touch: false, canShareFiles: false, canCopyImage: true }),
    ["clipboard", "download"]);
});

test("a download is always the last resort", () => {
  assert.deepEqual(shareOrder({ touch: true, canShareFiles: false, canCopyImage: false }), ["download"]);
});
