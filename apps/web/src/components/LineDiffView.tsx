import { useT } from "../i18n/index.js";

/**
 * A line diff with +/− markers (colour is never the only signal), shared by
 * version history's Changes (D41) and the sync-conflict Compare (D43).
 */
export interface DiffLineView {
  op: "same" | "add" | "remove";
  text: string;
}

/** The diff lines to show: all of them, or the changes with two lines of context. */
export function visibleLines(lines: readonly DiffLineView[], whole: boolean) {
  if (whole) return lines.map((line) => ({ ...line, gap: false }));
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.op === "same") return;
    for (let near = index - 2; near <= index + 2; near += 1) if (near >= 0 && near < lines.length) keep.add(near);
  });
  const out: Array<DiffLineView & { gap: boolean }> = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) out.push({ op: "same", text: "", gap: true });
    out.push({ ...lines[index]!, gap: false });
    previous = index;
  }
  return out;
}

export function LineDiffView({ lines, whole, testId }: { lines: readonly DiffLineView[]; whole: boolean; testId: string }) {
  const t = useT();
  return (
    <pre className="history-diff" data-testid={testId}>
      {visibleLines(lines, whole).map((line, index) =>
        line.gap ? (
          <span key={index} className="history-diff-gap" aria-hidden="true">
            ⋯{"\n"}
          </span>
        ) : (
          <span
            key={index}
            className={`history-diff-line history-diff-${line.op}`}
            data-op={line.op}
            aria-label={line.op === "same" ? undefined : `${line.op === "add" ? t("history.added") : t("history.removed")}: ${line.text}`}
          >
            <span className="history-diff-marker" aria-hidden="true">
              {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
            </span>
            {line.text}
            {"\n"}
          </span>
        ),
      )}
    </pre>
  );
}
