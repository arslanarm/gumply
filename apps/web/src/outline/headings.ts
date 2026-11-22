/**
 * The Outline pane's list (v0.8 D1, spec/outline): a page's top-level
 * headings, as Obsidian lists them, and a board's frames in reading order.
 * Read-only: nothing here touches the document or the file.
 */
import type { Node as PMNode } from "@tiptap/pm/model";

export interface OutlineEntry {
  /** 1–6 for headings; 1 for frames. */
  level: number;
  /** Plain text: marks dropped, links as their label. "" for an empty heading. */
  text: string;
  /** Stable across edits elsewhere on the page (collapsed state, React keys). */
  key: string;
  /** Document position of the heading. */
  pos: number;
  /** Indent steps in the tree: a skipped level (H1 → H3) is one step, not two. */
  depth: number;
}

/** A heading's text as the reader sees it: wiki links by their label, other atoms dropped. */
export function headingText(node: PMNode): string {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text ?? "";
    else if (child.type.name === "wikiLink") {
      const alias = String(child.attrs.alias ?? "");
      const target = String(child.attrs.targetTitle ?? "");
      text += alias || target.replace(/#\^?/, " › ");
    } else if (child.type.name === "hardBreak") text += " ";
    else text += child.textContent;
  });
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Indent steps per entry: each entry sits one step under the nearest earlier
 * entry with a lower level, so H1 → H3 indents once (as in Obsidian).
 */
export function nestLevels(levels: readonly number[]): number[] {
  const stack: { level: number; depth: number }[] = [];
  return levels.map((level) => {
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    const depth = stack.length ? stack[stack.length - 1]!.depth + 1 : 0;
    stack.push({ level, depth });
    return depth;
  });
}

/**
 * The page's outline: heading nodes that are direct children of the document.
 * Headings in callouts, quotes, list items and code are never reached, and the
 * pass doesn't descend into anything, so it stays cheap on long pages.
 */
export function outlineOf(doc: PMNode): OutlineEntry[] {
  const found: { level: number; text: string; pos: number }[] = [];
  // Headings directly in the page, and directly in a column (spec/columns: in
  // reading order, left column first). Nothing else is descended into.
  const visit = (parent: PMNode, start: number) => {
    parent.forEach((node, offset) => {
      const pos = start + offset;
      if (node.type.name === "columns") {
        node.forEach((column, columnOffset) => visit(column, pos + 1 + columnOffset + 1));
        return;
      }
      if (node.type.name !== "heading") return;
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
      found.push({ level, text: headingText(node), pos });
    });
  };
  visit(doc, 0);
  const depths = nestLevels(found.map((entry) => entry.level));
  // Keyed by level and text (and which occurrence), so a collapsed entry stays collapsed while the page is edited.
  const seen = new Map<string, number>();
  return found.map((entry, index) => {
    const base = `${entry.level}:${entry.text}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...entry, key: `${base}#${count}`, depth: depths[index]! };
  });
}

export interface FrameBox {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A board's frames in reading order: top to bottom, and left to right within
 * a row. Frames whose tops are within half the shorter one's height of each
 * other count as one row.
 */
export function framesInReadingOrder(frames: readonly FrameBox[]): FrameBox[] {
  const byTop = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: FrameBox[][] = [];
  for (const frame of byTop) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (row && first && frame.y - first.y < Math.min(first.height, frame.height) / 2) row.push(frame);
    else rows.push([frame]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** The heading the reader is in: the last one whose top is at or above `line` (−1 when none is). */
export function currentIndex(tops: readonly number[], line: number): number {
  let current = -1;
  for (let index = 0; index < tops.length; index++) {
    if (tops[index]! <= line) current = index;
    else break;
  }
  return current;
}

/** Which entries are hidden under a collapsed one. */
export function visibleEntries<T extends { depth: number; key: string }>(entries: readonly T[], collapsed: ReadonlySet<string>): T[] {
  const out: T[] = [];
  let hideBelow: number | null = null;
  for (const entry of entries) {
    if (hideBelow !== null && entry.depth > hideBelow) continue;
    hideBelow = null;
    out.push(entry);
    if (collapsed.has(entry.key)) hideBelow = entry.depth;
  }
  return out;
}

/** Whether an entry has children (the next entry is deeper). */
export function hasChildren(entries: readonly { depth: number }[], index: number): boolean {
  const next = entries[index + 1];
  return !!next && next.depth > entries[index]!.depth;
}

/** A board's frames as outline entries, in reading order (keyed by frame id). */
export function framesOutline(frames: readonly FrameBox[]): OutlineEntry[] {
  return framesInReadingOrder(frames).map((frame) => ({ level: 1, text: frame.title.trim(), key: frame.id, pos: 0, depth: 0 }));
}
