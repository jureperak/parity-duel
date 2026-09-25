// Sync backend for plain browsers: WebRTC peer-to-peer via PeerJS.
//
// The player who creates the game is the host: their browser keeps the game
// state, referees every guest's operations (protocol.ts), and broadcasts the
// result. PeerJS's signaling server is only used to introduce browsers; game
// messages go directly between them (or via a TURN relay on strict networks).
import { Peer } from "peerjs";
import type { DataConnection, PeerJSOption } from "peerjs";
import { parseMessage, encode, applyOps, authorize } from "./protocol.ts";
import type { Message, Op } from "./protocol.ts";
import type { Session, ConnectionStatus } from "./sync.ts";
import { iceServers } from "./ice.ts";

export const GAME_ID_RE = /^eo-[a-z0-9]{12}$/;

const OPEN_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 15_000;
const RETRY_MS = 2_000;
/** After this many failed reconnects in a row, tell the guest the host is gone (but keep trying). */
const HOST_LEFT_AFTER_FAILURES = 5;
/** A reloading guest drops and rejoins; give that a moment before calling them gone. */
const HOST_PRESENCE_SETTLE_MS = 5_000;

export function newGameId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "eo-" + Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}

/** PeerJS cloud by default; set VITE_PEERJS_HOST (and friends) to use your own server. */
function peerOptions(): PeerJSOption {
  const env = import.meta.env;
  // 0 none, 1 errors, 2 warnings, 3 everything (VITE_PEERJS_DEBUG=3 for diagnosing connections).
  const debug = Number(env.VITE_PEERJS_DEBUG ?? 1);
  const config: RTCConfiguration = { iceServers: iceServers(env) };
  if (!env.VITE_PEERJS_HOST) return { debug, config };
  return {
    config,
    host: env.VITE_PEERJS_HOST,
    port: env.VITE_PEERJS_PORT ? Number(env.VITE_PEERJS_PORT) : 443,
    path: env.VITE_PEERJS_PATH ?? "/",
    secure: env.VITE_PEERJS_SECURE !== "false",
    debug,
  };
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
    const timer = setTimeout(() => { peer.destroy(); reject(new Error("Signaling server unreachable")); }, OPEN_TIMEOUT_MS);
    peer.once("open", () => { clearTimeout(timer); resolve(peer); });
    peer.once("error", err => { clearTimeout(timer); peer.destroy(); reject(err); });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Tiny event helper so adapters don't each re-implement listener lists. */
function emitter(): { on: (l: () => void) => void; emit: () => void } {
  const listeners: (() => void)[] = [];
  return { on: l => { listeners.push(l); }, emit: () => listeners.forEach(l => l()) };
}

// ---------- host ----------

export async function hostGame(gameId: string, playerId: string): Promise<Session> {
  const storageKey = `eo-state:${gameId}`;
  const state = new Map<string, unknown>(restore(storageKey));
  const guests = new Map<DataConnection, string | null>(); // connection -> playerId once it said hello
  const changed = emitter(), presenceChanged = emitter(), statusChanged = emitter();
  const startedAt = Date.now();

  // After a reload the server may still hold our old ID for a few seconds.
  let peer: Peer | undefined;
  for (let attempt = 0; !peer; attempt++) {
    try {
      peer = await openPeer(gameId);
    } catch (err) {
      if ((err as { type?: string }).type !== "unavailable-id" || attempt >= 8) throw err;
      await sleep(RETRY_MS);
    }
  }

  const send = (conn: DataConnection, m: Message): void => { if (conn.open) void conn.send(encode(m)); };
  const broadcast = (m: Message): void => { for (const c of guests.keys()) send(c, m); };
  const online = (): Set<string> =>
    new Set([playerId, ...[...guests.values()].filter((id): id is string => id !== null)]);
  const presenceUpdate = (): void => {
    broadcast({ v: 1, t: "presence", online: [...online()] });
    presenceChanged.emit();
  };
  const commit = (ops: Op[]): void => {
    applyOps(state, ops);
    persist(storageKey, state);
    broadcast({ v: 1, t: "ops", ops });
    changed.emit();
  };

  peer.on("connection", conn => {
    if (conn.serialization !== "raw") { conn.close(); return; }
    guests.set(conn, null);
    conn.on("data", raw => {
      const m = parseMessage(raw);
      if (!m) return;
      const sender = guests.get(conn);
      if (m.t === "hello") {
        guests.set(conn, m.playerId);
        send(conn, { v: 1, t: "snapshot", entries: [...state] });
        presenceUpdate();
      } else if (m.t === "ops" && sender) {
        const reason = authorize(m.ops, sender, { get: k => state.get(k), isOnline: id => online().has(id) });
        if (reason) send(conn, { v: 1, t: "reject", reason });
        else commit(m.ops);
      }
    });
    const drop = (): void => { if (guests.delete(conn)) presenceUpdate(); };
    conn.on("close", drop);
    conn.on("error", drop);
  });
  // Losing the signaling server only stops new guests from joining; reconnect quietly.
  peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on("error", err => console.warn("PeerJS (host):", err.type, err.message));

  return {
    state: { get: k => state.get(k), apply: commit, subscribe: changed.on },
    presence: {
      onlinePlayerIds: online,
      settled: () => Date.now() - startedAt > HOST_PRESENCE_SETTLE_MS,
      subscribe: l => { presenceChanged.on(l); setTimeout(l, HOST_PRESENCE_SETTLE_MS + 50); },
    },
    status: () => "connected",
    onStatus: statusChanged.on,
  };
}

function restore(key: string): [string, unknown][] {
  try {
    const raw = sessionStorage.getItem(key);
    const entries: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(entries) ? entries as [string, unknown][] : [];
  } catch {
    return [];
  }
}

function persist(key: string, state: Map<string, unknown>): void {
  try { sessionStorage.setItem(key, JSON.stringify([...state])); } catch { /* reload would start fresh */ }
}

// ---------- guest ----------

export class GameNotFoundError extends Error {}

export async function joinGame(gameId: string, playerId: string): Promise<Session> {
  let state = new Map<string, unknown>();
  let online = new Set<string>();
  let presenceKnown = false;
  let status: ConnectionStatus = "reconnecting";
  let failures = 0;
  let conn: DataConnection | null = null;
  const changed = emitter(), presenceChanged = emitter(), statusChanged = emitter();
  const setStatus = (s: ConnectionStatus): void => { if (s !== status) { status = s; statusChanged.emit(); } };

  const peer = await openPeer();
  let firstSnapshot: (() => void) | null = null;
  const joined = new Promise<void>((resolve, reject) => {
    firstSnapshot = resolve;
    setTimeout(() => reject(new GameNotFoundError("Game not found")), JOIN_TIMEOUT_MS);
  });

  /** The attempt in flight; each one fails at most once, whichever signal arrives first. */
  let attempt: { fail: () => void } | null = null;

  function connect(): void {
    if (peer.destroyed) return;
    const c = peer.connect(gameId, { reliable: true, serialization: "raw" });
    let over = false;
    const fail = (): void => {
      if (over) return;
      over = true;
      clearTimeout(openTimer);
      if (conn === c) conn = null;
      failures++;
      setStatus(failures >= HOST_LEFT_AFTER_FAILURES ? "host-left" : "reconnecting");
      setTimeout(connect, RETRY_MS);
    };
    attempt = { fail };
    const openTimer = setTimeout(() => { if (!c.open) { c.close(); fail(); } }, OPEN_TIMEOUT_MS);
    c.on("open", () => {
      clearTimeout(openTimer);
      conn = c;
      void c.send(encode({ v: 1, t: "hello", playerId }));
    });
    c.on("data", raw => {
      const m = parseMessage(raw);
      if (!m) return;
      if (m.t === "snapshot") {
        state = new Map(m.entries);
        failures = 0;
        setStatus("connected");
        firstSnapshot?.();
        firstSnapshot = null;
        changed.emit();
      } else if (m.t === "ops") {
        applyOps(state, m.ops);
        changed.emit();
      } else if (m.t === "presence") {
        online = new Set(m.online);
        presenceKnown = true;
        presenceChanged.emit();
      } else if (m.t === "reject") {
        console.warn("Host rejected an action:", m.reason);
      }
    });
    c.on("close", fail);
    c.on("error", fail);
  }

  peer.on("error", err => {
    // The host isn't there (yet, or any more): this attempt failed, keep trying.
    if (err.type === "peer-unavailable") attempt?.fail();
    else console.warn("PeerJS (guest):", err.type, err.message);
  });
  peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });

  connect();
  try {
    await joined;
  } catch (err) {
    peer.destroy();
    throw err;
  }

  return {
    state: {
      get: k => state.get(k),
      apply: ops => {
        // Only the host changes state; our change comes back as a broadcast.
        if (conn?.open) void conn.send(encode({ v: 1, t: "ops", ops }));
        else console.warn("Not connected to the host; action dropped");
      },
      subscribe: changed.on,
    },
    presence: { onlinePlayerIds: () => online, settled: () => presenceKnown, subscribe: presenceChanged.on },
    status: () => status,
    onStatus: statusChanged.on,
  };
}
