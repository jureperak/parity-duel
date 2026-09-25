// Commit–reveal hashing on top of Web Crypto (browser and Node 22+).
import type { Side } from "./game.ts";

const DOMAIN = "even-odd:v1"; // versioned, so the scheme can change without ambiguity

/** 128 random bits as hex. Makes the committed number impossible to brute-force. */
export function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Commitment for one pick. Binds round and side too, so a commitment
 * can't be replayed in another round or for the other seat.
 */
export async function commitHash(round: number, side: Side, value: number, salt: string): Promise<string> {
  const input = new TextEncoder().encode(`${DOMAIN}:${round}:${side}:${value}:${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyReveal(
  commit: { round: number; hash: string },
  reveal: { round: number; value: number; salt: string },
  side: Side,
): Promise<boolean> {
  if (commit.round !== reveal.round) return false;
  return (await commitHash(reveal.round, side, reveal.value, reveal.salt)) === commit.hash;
}
