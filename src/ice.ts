// ICE configuration for WebRTC. Pure, so it can be tested without a browser.

/**
 * How browsers find a path to each other. STUN (free, public) covers most home
 * networks. A TURN relay is needed for the rest (mobile carriers, strict NATs,
 * some company networks); configure one with VITE_TURN_URLS / _USERNAME / _CREDENTIAL.
 * PeerJS's own default TURN servers no longer exist, so they're deliberately replaced.
 */
export function iceServers(env: Pick<ImportMetaEnv, "VITE_TURN_URLS" | "VITE_TURN_USERNAME" | "VITE_TURN_CREDENTIAL">): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  const urls = (env.VITE_TURN_URLS ?? "").split(",").map(u => u.trim()).filter(Boolean);
  if (urls.length > 0) {
    servers.push({ urls, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL });
  }
  return servers;
}
