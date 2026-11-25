import { describe, expect, it } from "vitest";
import { describeFlush, describeFlushes, flushAllSaved, flushSaved, NO_ANSWER, unsavedWindowNames } from "../src/flush-report";

describe("why the couldn't-be-saved dialog shows (#ms44vnit)", () => {
  it("reads the page's report, a bare boolean, or no answer", () => {
    expect(flushSaved({ saved: true, ms: 5, timedOut: false, unsaved: [] })).toBe(true);
    expect(flushSaved(true)).toBe(true);
    // A page without __gumplyFlush (the fallback script) answers true; undefined is not a refusal.
    expect(flushSaved(undefined)).toBe(true);
    expect(flushSaved(false)).toBe(false);
    expect(flushSaved(NO_ANSWER)).toBe(false);
    expect(flushSaved({ saved: false, ms: 5, timedOut: false, unsaved: [] })).toBe(false);
  });

  it("names the savers, the time and a timeout", () => {
    expect(describeFlush({ saved: true, ms: 5, timedOut: false, unsaved: [] }, 11_000)).toBeNull();
    expect(
      describeFlush(
        {
          saved: false,
          ms: 10_004,
          timedOut: true,
          unsaved: [
            { kind: "page", dirty: true, failed: false },
            { kind: "board", dirty: false, failed: true },
          ],
        },
        11_000,
      ),
    ).toBe("page still saving, board failed (flush took 10.0 s, timed out)");
    expect(describeFlush(NO_ANSWER, 11_000)).toBe("the page didn't answer within 11 s");
    expect(describeFlush(false, 11_000)).toBe("the page reported unsaved changes (no details)");
  });
});

describe("the flush over every window (#vhdp68sm, N8)", () => {
  const saved = { saved: true, ms: 4, timedOut: false, unsaved: [] };
  const stillSaving = { saved: false, ms: 10_002, timedOut: true, unsaved: [{ kind: "page", dirty: true, failed: false }] };

  it("one window reads exactly as before", () => {
    expect(flushAllSaved([{ name: "Notes", result: saved }])).toBe(true);
    expect(describeFlushes([{ name: "Notes", result: stillSaving }], 11_000)).toBe(describeFlush(stillSaving, 11_000));
    expect(describeFlushes([{ name: "Notes", result: saved }], 11_000)).toBeNull();
  });

  it("is saved only when every window is; a window that didn't answer is reported by name", () => {
    const results = [
      { name: "Roadmap", result: saved },
      { name: "Notes", result: NO_ANSWER },
      { name: "Board", result: stillSaving },
    ];
    expect(flushAllSaved(results)).toBe(false);
    expect(unsavedWindowNames(results)).toEqual(["Notes", "Board"]);
    expect(describeFlushes(results, 11_000)).toBe(
      `"Notes": the page didn't answer within 11 s; "Board": page still saving (flush took 10.0 s, timed out)`,
    );
  });

  it("several windows, all saved: nothing to say; no windows at all counts as saved", () => {
    expect(flushAllSaved([{ name: "A", result: saved }, { name: "B", result: true }])).toBe(true);
    expect(describeFlushes([{ name: "A", result: saved }, { name: "B", result: true }], 11_000)).toBeNull();
    expect(flushAllSaved([])).toBe(true);
  });
});
