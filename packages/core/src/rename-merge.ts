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
 * - So a `[[Old]]` the user typed (on a new line, or by editing a line) is never
 *   a rename change and is kept; a line the user edited keeps their text.
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
  for (let i = 0; i < baseLines.length; i++) {
    const line = baseLines[i]!;
    if (line === theirLines[i]) continue;
    const fromBase = inBase.get(line)!;
    const fromOurs = inOurs.get(line);
    // The user removed or edited it, or repeats it a different number of times: theirs isn't applied.
    if (!fromOurs || fromOurs.length !== fromBase.length) continue;
    const target = fromOurs[fromBase.indexOf(i)]!;
    ourLines[target] = theirLines[i]!;
    applied += 1;
  }
  return applied === 0 ? { content: ours, applied: 0 } : { content: ourLines.join("\n"), applied };
}
