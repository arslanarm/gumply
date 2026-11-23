import { describe, expect, it } from "vitest";
import { conflictSource } from "../src/lib/conflicts";

/** D43: where a conflict copy came from, as its name says (no time where the tool writes none). */
describe("conflictSource", () => {
  it("Dropbox: a person or computer and a date, never a time or \"time on\"", () => {
    const text = conflictSource({ tool: "dropbox", device: "Ann", at: "2026-11-21" });
    expect(text).toMatch(/^Dropbox, Ann's copy, /);
    expect(text).toContain("2026");
    expect(text).not.toContain("time on");
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("Syncthing: the device's own clock, labelled as such", () => {
    const text = conflictSource({ tool: "syncthing", device: "ABCDEFG", at: "2026-11-22T14:30:05" });
    expect(text).toMatch(/^Syncthing ABCDEFG, /);
    expect(text).toContain("(time on ABCDEFG)");
  });

  it("a date without a time is never labelled with a device's clock", () => {
    expect(conflictSource({ tool: "nextcloud", device: "ann", at: "2026-11-22" })).not.toContain("time on");
    expect(conflictSource({ tool: "nextcloud", at: "2026-11-22T14:30:05" })).not.toContain("time on");
  });
});
