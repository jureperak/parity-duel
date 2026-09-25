// "Copy badge" / "Share badge": turn the result card into a PNG for a chat.
//
// Phones get the native share sheet first: most mobile chat apps can't paste an
// image from the clipboard, and sharing sends it straight to WhatsApp, Teams…
// Computers copy to the clipboard for Ctrl+V.
//
// Browsers only allow clipboard/share access for a moment after a tap (iOS Safari
// is strict about this), so the image is rendered *before* the tap, as soon as the
// result appears, and the tap only has to hand it over.

export type ShareResult = "copied" | "shared" | "cancelled" | "downloaded";
export type ShareMethod = "share" | "clipboard" | "download";

/** Elements marked with this class are left out of the image (buttons, confetti). */
export const NO_CAPTURE = "no-capture";

const INK = "#140d1f"; // page background, so the card's rounded corners sit on the brand colour
/** Let the result animations play before spending CPU on the image. */
const PREPARE_DELAY_MS = 900;

/** Order to try, given what this device supports. Pure, so it's unit-tested. */
export function shareOrder(env: { touch: boolean; canShareFiles: boolean; canCopyImage: boolean }): ShareMethod[] {
  const order: ShareMethod[] = [];
  if (env.touch && env.canShareFiles) order.push("share");
  if (env.canCopyImage) order.push("clipboard");
  if (!env.touch && env.canShareFiles) order.push("share");
  order.push("download");
  return order;
}

/** True on phones and tablets, where the button should say "Share". */
export function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

const cache = new Map<string, Promise<Blob>>();

/** Start rendering the image for this result in the background, once. */
export function prepareBadge(key: string, card: HTMLElement): void {
  if (cache.has(key)) return;
  setTimeout(() => {
    if (cache.has(key) || !card.isConnected) return;
    const png = renderBadgePng(card);
    cache.set(key, png);
    png.catch(() => cache.delete(key)); // try again on tap
  }, PREPARE_DELAY_MS);
}

/**
 * The result card as a 2x PNG: without buttons or confetti, with a caption.
 *
 * Renders an off-screen copy of the card, so preparing the image never makes the
 * real card flicker. The copy is in a `capturing` state (see style.css): animations
 * frozen (they'd restart in the renderer, invisible at frame 0), buttons hidden,
 * caption shown, and gradient text swapped for solid colours, which the renderer
 * can't clip.
 */
export async function renderBadgePng(card: HTMLElement): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  const clone = card.cloneNode(true) as HTMLElement;
  clone.classList.add("capturing");
  const caption = document.createElement("div");
  caption.className = "share-caption";
  caption.textContent = `Even or Odd · ${location.host}${location.pathname.replace(/\/$/, "")}`;
  clone.append(caption);

  // Off-screen holder at the card's current width, so the layout matches what's on screen.
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${card.getBoundingClientRect().width}px;pointer-events:none`;
  holder.append(clone);
  document.body.append(holder);
  try {
    const blob = await domToBlob(clone, { scale: 2, backgroundColor: INK });
    if (!blob) throw new Error("Could not render the badge");
    return blob;
  } finally {
    holder.remove();
  }
}

/** Share or copy the badge. Call straight from a tap/click handler. */
export async function shareBadge(key: string, card: HTMLElement, fileName: string): Promise<ShareResult> {
  let png = cache.get(key);
  if (!png) {
    png = renderBadgePng(card);
    cache.set(key, png);
  }
  const canCopyImage = typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
  const probe = new File([], fileName, { type: "image/png" });
  const canShareFiles = typeof navigator.share === "function" && navigator.canShare?.({ files: [probe] }) === true;

  for (const method of shareOrder({ touch: isTouchDevice(), canShareFiles, canCopyImage })) {
    try {
      if (method === "share") {
        const file = new File([await png], fileName, { type: "image/png" });
        await navigator.share({ files: [file], title: "Even or Odd" });
        return "shared";
      }
      if (method === "clipboard") {
        // Pass the promise itself: Safari needs the write to start inside the tap.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        return "copied";
      }
      download(await png, fileName);
      return "downloaded";
    } catch (err) {
      // Closing the share sheet is a choice, not a failure: don't fall through to a download.
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      console.warn(`Badge ${method} failed, trying the next option`, err);
    }
  }
  throw new Error("No way to share the badge on this device");
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
