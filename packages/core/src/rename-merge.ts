import { maskCode } from "./links.js";

/**
 * N10 (#5pgmziyc): Keep mine in a page a rename rewrote while it was being
 * edited. The rename changed link spans in some lines (base → theirs); the
 * user's forced text (ours) started from base. Their link changes are applied
 * to ours only on lines the user didn't touch; everything else is ours as sent.
 *
 * - A rename only rewrites link spans inside lines, so base and theirs have the
 *   same lines; anything else is not a rename's change: ours is returned as is.
 * - A changed base line is found in ours by its exact text. A line that occurs
 *   several times is matched by order, and only when base and ours have it the
 *   same number of times; otherwise (ambiguous) it's left alone.
 * - So a `[[Old]]` the user typed (on a new line, or a second time in a line) is
 *   never a rename change and is kept.
 * - #z9hufufn: a line the user edited keeps their text, with the rename's link
 *   changes applied inside it when that is unambiguous (see below).
 */
export function mergeRenameLinks(base: string, theirs: string, ours: string): { content: string; applied: number } {
  const baseLines = base.split("\n");
  const theirLines = theirs.split("\n");
  if (baseLines.length !== theirLines.length || base === theirs) return { content: ours, applied: 0 };
  const ourLines = ours.split("\n");

  const positions = (lines: readonly string[]) => {
    const at = new Map<string, number[]>();
    lines.forEach((line, index) => {
      const list = at.get(line);
      if (list) list.push(index);
      else at.set(line, [index]);
    });
    return at;
  };
  const inBase = positions(baseLines);
  const inOurs = positions(ourLines);

  let applied = 0;
  const edited: number[] = [];
  for (let i = 0; i < baseLines.length; i++) {
    const line = baseLines[i]!;
    if (line === theirLines[i]) continue;
    const fromBase = inBase.get(line)!;
    const fromOurs = inOurs.get(line);
    // The user removed or edited it, or repeats it a different number of times: not as a whole line.
    if (!fromOurs || fromOurs.length !== fromBase.length) {
      edited.push(i);
      continue;
    }
    const target = fromOurs[fromBase.indexOf(i)]!;
    ourLines[target] = theirLines[i]!;
    applied += 1;
  }
  // #z9hufufn: a line the user edited still gets the rename's link changes, link by link, when that is
  // unambiguous: the line's old links are found, as many times as before, in exactly one line of theirs
  // that isn't an untouched line and keeps the original's start or end. Only link spans are replaced, at
  // their positions, never text inside code (as the rename's own rewrite skips code); a link the user
  // changed or typed again is left as they wrote it.
  const untouched = new Set(baseLines);
  const maskedBase = maskCode(base).split("\n");
  const maskedOurs = maskCode(ours).split("\n");
  const claimed = new Set<number>();
  for (const i of edited) {
    const swaps = linkSwaps(maskedBase[i]!, baseLines[i]!, theirLines[i]!);
    if (swaps === null || swaps.size === 0) continue;
    const baseCounts = linkCounts(maskedBase[i]!);
    const candidates = ourLines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line, index }) =>
          !claimed.has(index) &&
          !untouched.has(line) &&
          // An edit keeps the line's start or its end (typing at the end, in the middle, or at the start);
          // a line typed fresh with an old link in it is not this line.
          sharesEdge(line, baseLines[i]!) &&
          [...swaps.keys()].every((from) => (linkCounts(maskedOurs[index]!).get(from) ?? 0) === (baseCounts.get(from) ?? 0)),
      );
    if (candidates.length !== 1) continue;
    const { line, index } = candidates[0]!;
    let next = "";
    let last = 0;
    for (const match of maskedOurs[index]!.matchAll(LINK)) {
      const to = swaps.get(match[0]);
      if (to === undefined) continue;
      next += line.slice(last, match.index) + to;
      last = match.index! + match[0].length;
    }
    next += line.slice(last);
    if (next === line) continue;
    ourLines[index] = next;
    claimed.add(index);
    applied += 1;
  }
  return applied === 0 ? { content: ours, applied: 0 } : { content: ourLines.join("\n"), applied };
}

/** A wikilink, embed or Markdown link, as written. */
const LINK = /!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)/g;

/**
 * The link changes between two versions of a line (old link text → new), by position outside code; null
 * when the lines differ in anything but those links (not a rename's change), or one old link became two
 * different ones. `maskedBefore` is `before` with its code masked (the same length).
 */
function linkSwaps(maskedBefore: string, before: string, after: string): Map<string, string> | null {
  const swaps = new Map<string, string>();
  let rebuilt = "";
  let last = 0;
  let offset = 0;
  for (const match of maskedBefore.matchAll(LINK)) {
    const at = match.index!;
    rebuilt += before.slice(last, at);
    // The rename's version of this span: the same start in `after`, shifted by the changes so far.
    const tail = after.slice(at + offset);
    const replaced = tail.match(new RegExp(`^(?:${LINK.source})`));
    if (!replaced) return null;
    const from = match[0];
    const to = replaced[0];
    if (from !== to) {
      const known = swaps.get(from);
      if (known !== undefined && known !== to) return null;
      swaps.set(from, to);
    }
    rebuilt += to;
    offset += to.length - from.length;
    last = at + from.length;
  }
  rebuilt += before.slice(last);
  return rebuilt === after ? swaps : null;
}

/** How many times each link appears in a (code-masked) line. */
function linkCounts(masked: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of masked.matchAll(LINK)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  return counts;
}

/** The two lines start or end with the same 4+ characters (or one of them is shorter than that and matches). */
function sharesEdge(a: string, b: string): boolean {
  const need = Math.min(4, a.length, b.length);
  if (need === 0) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length && end < b.length && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return start >= need || end >= need;
}


