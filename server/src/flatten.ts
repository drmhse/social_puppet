import { FlatEntry, TreeNode, WaitMatch } from "./types.js";

/** Walk the tree depth-first, keeping only visible, non-zero-size nodes that carry
 *  text, a content description, or are clickable. These become the "screen". */
export function flattenTree(nodes: TreeNode[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  const walk = (n: TreeNode): void => {
    if (!n.visible) return;
    const [l, t, r, b] = n.bounds;
    if (r <= l || b <= t) return;
    const hasText = n.text !== undefined && n.text.trim().length > 0;
    const hasDesc = n.contentDesc !== undefined && n.contentDesc.trim().length > 0;
    if (hasText || hasDesc || n.clickable) {
      out.push({
        id: n.id,
        text: hasText ? n.text : undefined,
        desc: hasDesc ? n.contentDesc : undefined,
        resourceId: n.resourceId,
        cls: n.className,
        x: l,
        y: t,
        w: r - l,
        h: b - t,
        clickable: !!n.clickable,
      });
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** Render entries as a readable transcript for LLM consumption. */
export function entriesToText(
  entries: FlatEntry[],
  limit = 200,
): { text: string; truncated: boolean } {
  const shown = limit > 0 ? entries.slice(0, limit) : entries;
  const lines = shown.map((e) => {
    const label = e.text ?? e.desc ?? e.resourceId ?? "(unnamed)";
    const click = e.clickable ? " [btn]" : "";
    return `${e.id} | ${label}${click} @(${e.x},${e.y}) ${e.w}x${e.h}`;
  });
  return { text: lines.join("\n"), truncated: entries.length > shown.length };
}

/** Case-insensitive match against a find-spec. `contains` makes text matching a
 *  substring test instead of equality. */
export function matchEntries(
  entries: FlatEntry[],
  m: WaitMatch,
): FlatEntry | undefined {
  const norm = (s?: string) => (s ?? "").toLowerCase();
  return entries.find((e) => {
    if (m.text !== undefined) {
      const t = norm(e.text);
      if (m.contains) {
        if (!t.includes(norm(m.text))) return false;
      } else if (t !== norm(m.text)) {
        return false;
      }
    }
    if (m.resourceId !== undefined) {
      const t = norm(e.resourceId);
      if (m.contains) {
        if (!t.includes(norm(m.resourceId))) return false;
      } else if (t !== norm(m.resourceId)) {
        return false;
      }
    }
    if (m.contentDesc !== undefined) {
      const t = norm(e.desc);
      if (m.contains) {
        if (!t.includes(norm(m.contentDesc))) return false;
      } else if (t !== norm(m.contentDesc)) {
        return false;
      }
    }
    return true;
  });
}
