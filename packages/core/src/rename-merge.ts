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
  // that isn't an untouched line. A link the user changed or typed again is left as they wrote it.
  const untouched = new Set(baseLines);
  const claimed = new Set<number>();
  for (const i of edited) {
    const swaps = linkSwaps(baseLines[i]!, theirLines[i]!);
    if (swaps === null || swaps.length === 0) continue;
    const candidates = ourLines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line, index }) =>
          !claimed.has(index) &&
          !untouched.has(line) &&
          // An edit keeps the line's start or its end (typing at the end, in the middle, or at the start);
          // a line typed fresh with an old link in it is not this line.
          sharesEdge(line, baseLines[i]!) &&
          swaps.every(([from]) => count(line, from) === count(baseLines[i]!, from)),
      );
    if (candidates.length !== 1) continue;
    const { line, index } = candidates[0]!;
    let next = line;
    for (const [from, to] of swaps) next = next.split(from).join(to);
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
 * The link changes between two versions of a line (old link text → new), in order; null when the lines
 * differ in anything but links (not a rename's change), or have a different number of links.
 */
function linkSwaps(before: string, after: string): Array<[string, string]> | null {
  const a = before.match(LINK) ?? [];
  const b = after.match(LINK) ?? [];
  if (a.length !== b.length) return null;
  if (before.replace(LINK, "\u0000") !== after.replace(LINK, "\u0000")) return null;
  const swaps: Array<[string, string]> = [];
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue;
    const known = swaps.find(([from]) => from === a[k]);
    if (known && known[1] !== b[k]) return null; // the same old link became two different ones
    if (!known) swaps.push([a[k]!, b[k]!]);
  }
  return swaps;
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

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}
