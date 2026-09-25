// Tiny DOM builder. Children are always inserted as text nodes, never as HTML,
// so data from other clients can't inject markup.

export type Child = Node | string | number | null | undefined | false | Child[];
export type PropValue = string | number | boolean | null | undefined | ((e: Event) => void);
export type Props = Record<string, PropValue>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") node.className = String(v);
    else if (typeof v === "string" || typeof v === "number") node.setAttribute(k, String(v));
    else if (v === true) node.setAttribute(k, "");
  }
  const append = (c: Child): void => {
    if (Array.isArray(c)) return c.forEach(append);
    if (c == null || c === false) return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(append);
  return node;
}

export const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
