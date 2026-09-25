// Peer-to-peer wire protocol and the host's referee rules. Pure: no PeerJS, no DOM.
//
// The host holds the one true copy of the game state. Guests never change state
// themselves: they send a batch of operations, the host checks it against the
// rules below, applies it, and broadcasts it to everyone (the sender included).
// Because only the host orders operations, every client sees the same history.
import { SIDES, asPlayer, asCommit, asReveal } from "./game.ts";
import type { Side } from "./game.ts";

export type Op = { key: string; value: unknown } | { key: string; delete: true };

export const PROTOCOL_VERSION = 1;
/** A 48x48 photo is ~4 KB; anything much bigger than a seat is not a real message. */
export const MAX_MESSAGE_CHARS = 64_000;
export const MAX_OPS_PER_BATCH = 8;

export type Message =
  | { v: 1; t: "hello"; playerId: string }                         // guest -> host
  | { v: 1; t: "ops"; ops: Op[] }                                   // both ways
  | { v: 1; t: "snapshot"; entries: [string, unknown][] }           // host -> guest
  | { v: 1; t: "presence"; online: string[] }                       // host -> guest
  | { v: 1; t: "reject"; reason: string };                          // host -> guest

const KEY_RE = /^(seat|commit|reveal):(even|odd)$|^round$/;
const PLAYER_ID_RE = /^[0-9a-f-]{8,64}$/;

export function isOp(v: unknown): v is Op {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || !KEY_RE.test(o.key)) return false;
  return o.delete === true || "value" in o;
}

/** Parse anything that arrived over the wire; null if it isn't a valid message. */
export function parseMessage(raw: unknown): Message | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_CHARS) return null;
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  if (o.v !== PROTOCOL_VERSION) return null;
  switch (o.t) {
    case "hello":
      return typeof o.playerId === "string" && PLAYER_ID_RE.test(o.playerId)
        ? { v: 1, t: "hello", playerId: o.playerId } : null;
    case "ops":
      return Array.isArray(o.ops) && o.ops.length > 0 && o.ops.length <= MAX_OPS_PER_BATCH && o.ops.every(isOp)
        ? { v: 1, t: "ops", ops: o.ops } : null;
    case "snapshot":
      return Array.isArray(o.entries) && o.entries.every(e =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && KEY_RE.test(e[0]))
        ? { v: 1, t: "snapshot", entries: o.entries as [string, unknown][] } : null;
    case "presence":
      return Array.isArray(o.online) && o.online.every(id => typeof id === "string")
        ? { v: 1, t: "presence", online: o.online } : null;
    case "reject":
      return typeof o.reason === "string" ? { v: 1, t: "reject", reason: o.reason.slice(0, 200) } : null;
    default:
      return null;
  }
}

export const encode = (m: Message): string => JSON.stringify(m);

export function applyOps(state: Map<string, unknown>, ops: Op[]): void {
  for (const op of ops) {
    if ("delete" in op) state.delete(op.key);
    else state.set(op.key, op.value);
  }
}

// ---------- referee ----------

export interface RefereeView {
  get(key: string): unknown;
  isOnline(playerId: string): boolean;
}

/**
 * May `sender` apply this batch? Checked op by op against the state as the
 * batch would leave it, and all-or-nothing: one bad op rejects the batch.
 * Returns null if allowed, or a reason.
 */
export function authorize(ops: Op[], sender: string, view: RefereeView): string | null {
  const draft = new Map<string, unknown>();
  const get = (k: string): unknown => (draft.has(k) ? draft.get(k) : view.get(k));
  const seatId = (s: Side): string | undefined => asPlayer(get(`seat:${s}`))?.id;
  // Who was seated before this batch: only they may move other players (a swap).
  const seatedBefore = new Set(SIDES.map(s => asPlayer(view.get(`seat:${s}`))?.id).filter(Boolean));
  const senderSeatedBefore = seatedBefore.has(sender);

  for (const op of ops) {
    const [kind, sideRaw] = op.key.split(":");
    const side = sideRaw as Side | undefined;
    const isDelete = "delete" in op;

    if (kind === "seat" && side) {
      const current = seatId(side);
      if (isDelete) {
        if (current !== sender && !senderSeatedBefore) return "can only leave your own seat";
      } else {
        const next = asPlayer(op.value);
        if (!next) return "invalid player";
        if (next.id === sender) {
          if (current !== sender) {
            const free = !current || !view.isOnline(current);
            const swapping = senderSeatedBefore && current !== undefined && seatedBefore.has(current);
            if (!free && !swapping) return "seat is taken";
            if (seatId(side === "even" ? "odd" : "even") === sender) return "already seated on the other side";
          }
        } else if (!(senderSeatedBefore && seatedBefore.has(next.id))) {
          return "can't seat another player";
        }
      }
    } else if ((kind === "commit" || kind === "reveal") && side) {
      if (isDelete) {
        // Leaving or resetting clears picks; only a player who was seated may do that.
        if (!senderSeatedBefore) return `can't clear a ${kind}`;
      } else {
        if (seatId(side) !== sender) return `can only ${kind} for your own seat`;
        if (!(kind === "commit" ? asCommit(op.value) : asReveal(op.value))) return `invalid ${kind}`;
      }
    } else if (kind === "round") {
      if (isDelete || !Number.isInteger(op.value)) return "invalid round";
      const current = Number(get("round") ?? 1);
      const seatedNow = SIDES.some(s => seatId(s) === sender);
      const everyoneLeft = SIDES.every(s => !seatId(s));
      if (op.value === current + 1 && (seatedNow || senderSeatedBefore)) { /* next round */ }
      else if (op.value === 1 && everyoneLeft) { /* reset */ }
      else return "invalid round change";
    } else {
      return "unknown key";
    }

    // A deleted key must read as missing, not fall back to the pre-batch value.
    draft.set(op.key, isDelete ? undefined : op.value);
  }
  return null;
}
