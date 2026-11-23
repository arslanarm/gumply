/**
 * Version history's Changes (#h4tyk92t): Gumply writes `updated:` on every
 * save (and `created:` when a note lacks it), so nearly every version differed
 * from now in that line, noise next to what the user changed. In the
 * frontmatter, a changed managed key shows as unchanged at its current value.
 * Display only: "Show whole file" shows the raw diff, and Restore writes the
 * version's exact bytes.
 */
import type { DiffLineView } from "../components/LineDiffView.js";

/** The frontmatter keys the store writes by itself. */
export const MANAGED_KEYS: readonly string[] = ["updated", "created"];

const managedLine = new RegExp(`^(${MANAGED_KEYS.join("|")}):`);

/**
 * The diff (this version → now) without changes to managed keys inside the
 * leading frontmatter: their "remove" lines are dropped and their "add" lines
 * shown as unchanged. Everything else, including such keys in the body, stays.
 */
export function hideManagedKeyChanges(lines: readonly DiffLineView[]): DiffLineView[] {
  if (lines[0]?.text !== "---") return [...lines];
  const out: DiffLineView[] = [];
  let inFrontmatter = true;
  lines.forEach((line, index) => {
    if (index > 0 && inFrontmatter && line.text === "---") {
      out.push(line);
      inFrontmatter = false;
      return;
    }
    if (inFrontmatter && line.op !== "same" && managedLine.test(line.text)) {
      if (line.op === "add") out.push({ op: "same", text: line.text });
      return;
    }
    out.push(line);
  });
  return out;
}
