/**
 * v0.8 C2 (#u84ebtf3): when a heading is renamed in a saved page, links to
 * it elsewhere (`[[Page#Old]]`, `[[Page#Old|alias]]`, `![[Page#Old]]`,
 * `[[Page#Parent#Old]]`) follow it, as Obsidian does.
 *
 * Conservative on purpose: a rename is only recognised when the page keeps
 * the same number of headings, the heading keeps its place and level, the old
 * text was unique before and is gone after, and the new text is unique after.
 * Anything else (headings added, removed, duplicated) leaves links alone.
 */
import { extractWikilinks, type WikiLink } from "./links.js";
import { headingKey, pageHeadings } from "./page-embeds.js";

export interface HeadingRename {
  /** The old heading text, as it was written. */
  from: string;
  /** The new heading text, as it is written now. */
  to: string;
}

function counts(keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

/** The headings renamed between two versions of a page body (see the module note). */
export function headingRenames(before: string, after: string): HeadingRename[] {
  const old = pageHeadings(before);
  const now = pageHeadings(after);
  if (old.length === 0 || old.length !== now.length) return [];
  const oldKeys = old.map((heading) => headingKey(heading.text));
  const newKeys = now.map((heading) => headingKey(heading.text));
  const oldCount = counts(oldKeys);
  const newCount = counts(newKeys);
  const renames: HeadingRename[] = [];
  for (let index = 0; index < old.length; index += 1) {
    const from = oldKeys[index]!;
    const to = newKeys[index]!;
    if (from === to || !from || !to) continue;
    if (old[index]!.level !== now[index]!.level) continue;
    if (oldCount.get(from) !== 1 || newCount.has(from) || newCount.get(to) !== 1) continue;
    renames.push({ from: old[index]!.text, to: now[index]!.text });
  }
  return renames;
}

/** Heading text as it can sit inside `[[…#…]]`: no brackets, `#` or `|`. */
function linkHeadingText(text: string): string {
  return text.replace(/[[\]#|]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Rewrite the heading part of the links `isTarget` picks. Only the matching
 * heading segment changes: the target as written, `!`, the alias or size,
 * `#^block` segments and every other byte stay. Links in code are left alone.
 */
export function rewriteHeadingLinks(
  markdown: string,
  isTarget: (link: WikiLink) => boolean,
  renames: readonly HeadingRename[],
): { content: string; count: number } {
  if (renames.length === 0) return { content: markdown, count: 0 };
  const byKey = new Map(renames.map((rename) => [headingKey(rename.from), linkHeadingText(rename.to)]));
  let content = markdown;
  let count = 0;
  const links = extractWikilinks(markdown).filter((link) => link.heading && isTarget(link));
  for (const link of [...links].reverse()) {
    const open = link.raw.startsWith("!") ? 3 : 2;
    const inner = link.raw.slice(open, -2);
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const rest = pipe === -1 ? "" : inner.slice(pipe);
    const hash = targetPart.indexOf("#");
    if (hash === -1) continue;
    let changed = false;
    const segments = targetPart
      .slice(hash + 1)
      .split("#")
      .map((segment) => {
        const trimmed = segment.trim();
        if (!trimmed || trimmed.startsWith("^")) return segment;
        const next = byKey.get(headingKey(trimmed));
        if (next === undefined || !next) return segment;
        changed = true;
        return segment.replace(trimmed, next);
      });
    if (!changed) continue;
    const raw = `${link.raw.slice(0, open)}${targetPart.slice(0, hash + 1)}${segments.join("#")}${rest}]]`;
    content = content.slice(0, link.index) + raw + content.slice(link.index + link.raw.length);
    count += 1;
  }
  return { content, count };
}
