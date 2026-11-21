import { describe, expect, it } from "vitest";
import { describeFlush, flushSaved, NO_ANSWER } from "../src/flush-report";

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
