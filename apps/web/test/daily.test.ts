import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { dailyNeighbours, todayDay } from "../src/lib/daily.js";

const meta = (id: string, kind: PageMeta["kind"] = "page"): PageMeta => ({
  id,
  kind,
  title: id.split("/").pop() ?? id,
  tags: [],
  parentId: null,
  childCount: 0,
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
});

const settings = { folder: "Daily", format: "YYYY-MM-DD", template: "" };

describe("daily notes in the app (#5hrsrqsj)", () => {
  it("today is the local calendar day", () => {
    expect(todayDay(new Date(2026, 2, 6, 23, 59))).toBe("2026-03-06");
  });

  it("‹ › go to the nearest existing daily notes, skipping gaps and other pages", () => {
    const pages = [
      meta("Daily/2026-03-01"),
      meta("Daily/2026-03-04"),
      meta("Daily/2026-03-06"),
      meta("Daily/2026-03-09"),
      meta("Daily/Ideas"),
      meta("Daily", "folder"),
      meta("2026-03-05"),
    ];
    expect(dailyNeighbours(pages, settings, "Daily/2026-03-06")).toEqual({
      day: "2026-03-06",
      previous: "Daily/2026-03-04",
      next: "Daily/2026-03-09",
    });
    expect(dailyNeighbours(pages, settings, "Daily/2026-03-01")).toMatchObject({ previous: null, next: "Daily/2026-03-04" });
    expect(dailyNeighbours(pages, settings, "Daily/2026-03-09")).toMatchObject({ previous: "Daily/2026-03-06", next: null });
    expect(dailyNeighbours(pages, settings, "Daily/Ideas")).toBeNull();
  });
});
