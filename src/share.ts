// "Copy badge": turn the result card into a PNG people can paste into a chat.
// The renderer (~40 kB) is loaded only when someone actually copies a badge.

export type ShareResult = "copied" | "shared" | "downloaded";

/** Elements marked with this class are left out of the image (buttons, confetti). */
export const NO_CAPTURE = "no-capture";

const INK = "#140d1f"; // page background, so the card's rounded corners sit on the brand colour

/**
 * The result card as a 2x PNG, without buttons or confetti, with a caption.
 *
 * The renderer copies the card's computed styles into an SVG, so the *live* card
 * is put into a `capturing` state for the moment of capture (see style.css):
 * animations frozen (they'd restart in the copy, invisible at frame 0), buttons
 * hidden so the size recalculates, caption shown, and gradient text swapped for
 * solid colours, which the SVG renderer can't clip.
 */
export async function renderBadgePng(card: HTMLElement): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  if (!card.querySelector(".share-caption")) {
    const caption = document.createElement("div");
    caption.className = "share-caption";
    caption.textContent = `Even or Odd · ${location.host}${location.pathname.replace(/\/$/, "")}`;
    card.append(caption);
  }
  card.classList.add("capturing");
  try {
    // Apply the capture styles now. (Not requestAnimationFrame: it never fires in a background tab.)
    void card.offsetHeight;
    const blob = await domToBlob(card, { scale: 2, backgroundColor: INK });
    if (!blob) throw new Error("Could not render the badge");
    return blob;
  } finally {
    card.classList.remove("capturing");
  }
}

/**
 * Copy the card as an image; fall back to the share sheet (phones), then to a download.
 * Must be called from a click handler: browsers only allow clipboard and share
 * access in response to a user gesture.
 */
export async function shareBadge(card: HTMLElement, fileName: string): Promise<ShareResult> {
  // Start rendering immediately and hand the clipboard a promise: Safari requires the
  // clipboard call to happen synchronously within the click, before the image is ready.
  const png = renderBadgePng(card);

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {
      // Blocked (e.g. inside an iframe without clipboard permission): try the next option.
    }
  }

  const file = new File([await png], fileName, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Even or Odd" });
      return "shared";
    } catch (err) {
      // The user closing the share sheet isn't a failure worth a download.
      if (err instanceof DOMException && err.name === "AbortError") return "shared";
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}
