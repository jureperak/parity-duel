// Badge art is static, trusted SVG. Titles/messages are plain text templates:
// {winner}, {loser}, {sum}, {side} are filled in with textContent, never HTML.

const medal = (inner: string, from: string, to: string): string => `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="g-${from.slice(1)}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <path d="M38 4h16l8 26-12 6zM82 4H66l-8 26 12 6z" fill="#c4314b"/>
  <circle cx="60" cy="72" r="44" fill="url(#g-${from.slice(1)})"/>
  <circle cx="60" cy="72" r="36" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-dasharray="4 5"/>
  ${inner}
</svg>`;

const TROPHY = medal(`
  <path d="M44 52h32v10a16 16 0 0 1-32 0z" fill="#fff"/>
  <path d="M44 56h-8a8 8 0 0 0 8 10M76 56h8a8 8 0 0 1-8 10" fill="none" stroke="#fff" stroke-width="4"/>
  <rect x="56" y="77" width="8" height="8" fill="#fff"/>
  <rect x="48" y="85" width="24" height="6" rx="2" fill="#fff"/>`, "#ffd35c", "#e08e0b");

const CROWN = medal(`
  <path d="M38 88l-4-30 14 12 12-20 12 20 14-12-4 30z" fill="#fff"/>
  <circle cx="60" cy="48" r="4" fill="#fff"/><circle cx="34" cy="56" r="4" fill="#fff"/><circle cx="86" cy="56" r="4" fill="#fff"/>`,
  "#b69cff", "#5b5fc7");

const STAR = medal(`
  <path d="M60 44l8.2 16.6 18.3 2.7-13.3 12.9 3.1 18.2L60 85.8l-16.3 8.6 3.1-18.2-13.3-12.9 18.3-2.7z" fill="#fff"/>`,
  "#7ee0c3", "#107c6d");

const ROCKET = medal(`
  <path d="M60 40c10 8 14 20 12 34H48c-2-14 2-26 12-34z" fill="#fff"/>
  <circle cx="60" cy="58" r="5" fill="#e0556b"/>
  <path d="M48 66l-8 12h10zM72 66l8 12H70z" fill="#fff"/>
  <path d="M54 76h12l-6 16z" fill="#ffd35c"/>`, "#ff9a8b", "#c4314b");

const CLOUD = medal(`
  <path d="M42 72a10 10 0 0 1 4-19 14 14 0 0 1 27-2 10 10 0 0 1 5 21z" fill="#fff"/>
  <path d="M48 80l-3 8M60 80l-3 8M72 80l-3 8" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`,
  "#a9c6e8", "#5f7fa6");

const SNAIL = medal(`
  <circle cx="64" cy="68" r="14" fill="none" stroke="#fff" stroke-width="5"/>
  <circle cx="64" cy="68" r="5" fill="#fff"/>
  <path d="M36 84h44" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
  <path d="M44 84c-4-6-4-12 0-18M40 60l-2-8M46 60l2-8" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/>`,
  "#c7d98a", "#6b8e23");

const DICE = medal(`
  <rect x="40" y="52" width="40" height="40" rx="8" fill="#fff"/>
  <circle cx="50" cy="62" r="4" fill="#8a6fd1"/><circle cx="70" cy="82" r="4" fill="#8a6fd1"/><circle cx="60" cy="72" r="4" fill="#8a6fd1"/>`,
  "#d7c7ff", "#8a6fd1");

export interface Badge {
  art: string;     // trusted static SVG markup
  title: string;   // text template
  message: string; // text template
}

export type BadgeVars = Record<string, string | number>;

export const WIN_BADGES: readonly Badge[] = [
  { art: TROPHY, title: "Parity Champion", message: "{sum} is {side}. {winner} reads minds for a living." },
  { art: CROWN,  title: "Ruler of the {Side}s", message: "Bow down — {winner} called it. {loser}, maybe next round." },
  { art: STAR,   title: "Number Whisperer", message: "The digits spoke, and they said {winner}. Final sum: {sum}." },
  { art: ROCKET, title: "To the Moon", message: "{winner} launches ahead! {sum} lands squarely on {side}." },
];

export const LOSE_BADGES: readonly Badge[] = [
  { art: CLOUD, title: "Brief Shower", message: "It's only one round. {sum} was {side} — the tide will turn." },
  { art: SNAIL, title: "Slow and Steady", message: "{winner} got this one, but legends are built on comebacks." },
  { art: DICE,  title: "Blame the Dice", message: "Pure chance, obviously. {sum} simply wasn't your number." },
];

export function fill(template: string, vars: BadgeVars): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}
