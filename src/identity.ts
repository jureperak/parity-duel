// Who the local player is, and how any player is drawn (photo or initials).
import type { LivePresence, LivePresenceUser } from "@microsoft/live-share";
import type { Player } from "./game.ts";

const MAX_PHOTO_CHARS = 30_000; // a 48x48 thumbnail is ~2-4 KB as base64
const PHOTO_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Photos arrive from other clients: only accept small inline JPEG/PNG data URLs. */
export function safePhoto(url: unknown): string | null {
  return typeof url === "string" && url.length <= MAX_PHOTO_CHARS && PHOTO_RE.test(url) ? url : null;
}

/**
 * Teams display name of this client, via Live Share presence.
 * Resolves null if Teams doesn't report one within a few seconds.
 */
export function teamsDisplayName<T extends object>(presence: LivePresence<T>, timeoutMs = 5000): Promise<string | null> {
  const now = () => presence.getUsers().find(u => u.isLocalUser)?.displayName || null;
  return new Promise<string | null>(resolve => {
    const immediate = now();
    if (immediate) return resolve(immediate);
    const onChange = (user: LivePresenceUser<T>, local: boolean) => {
      if (local && user.displayName) { done(); resolve(user.displayName); }
    };
    const timer = setTimeout(() => { done(); resolve(now()); }, timeoutMs);
    const done = () => { clearTimeout(timer); presence.off("presenceChanged", onChange); };
    presence.on("presenceChanged", onChange);
  });
}

/**
 * The signed-in user's own 48x48 profile photo as a data URL, or null.
 * Uses Teams nested app auth, so it only works inside Teams and only when an
 * Entra app registration is configured (VITE_ENTRA_CLIENT_ID).
 */
export async function fetchMyPhoto(clientId: string | undefined): Promise<string | null> {
  if (!clientId) return null;
  // Loaded on demand: MSAL is only needed when photos are configured.
  const { createNestablePublicClientApplication } = await import("@azure/msal-browser");
  const msal = await createNestablePublicClientApplication({
    auth: { clientId, authority: "https://login.microsoftonline.com/common" },
  });
  const request = { scopes: ["User.Read"] };
  let token: string;
  try {
    token = (await msal.acquireTokenSilent(request)).accessToken;
  } catch {
    token = (await msal.acquireTokenPopup(request)).accessToken; // first-time consent
  }

  const res = await fetch("https://graph.microsoft.com/v1.0/me/photos/48x48/$value", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null; // user has no photo
  if (!res.ok) throw new Error(`Graph photo request failed: ${res.status}`);

  const blob = await res.blob();
  const url = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read photo"));
    reader.readAsDataURL(blob);
  });
  return safePhoto(url);
}

export function initials(name: string | null | undefined): string {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || "?").slice(0, 2);
  return letters.toUpperCase();
}

// A stable colour per name, drawn from the ember/violet family.
const AVATAR_COLORS = ["#e0412a", "#c2255c", "#7b34e0", "#5a3fd1", "#d0562b", "#a42e8f", "#3f5bd9", "#b8408a"];
export function avatarColor(name: string | null | undefined): string {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** <div class="avatar"> with the player's photo, or coloured initials as fallback. */
export function avatar(player: Pick<Player, "name" | "photo"> | null | undefined, size = 40): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.width = el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.4)}px`;
  const photo = safePhoto(player?.photo);
  if (photo) {
    const img = document.createElement("img");
    img.src = photo;
    img.alt = "";
    el.append(img);
  } else {
    el.style.background = avatarColor(player?.name);
    el.textContent = initials(player?.name);
  }
  el.setAttribute("aria-hidden", "true");
  return el;
}
