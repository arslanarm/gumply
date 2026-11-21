import { describe, expect, it } from "vitest";
import {
  dailyNoteDay,
  dailyNoteId,
  dateFromDay,
  formatMomentDate,
  parseMomentDate,
  renderTemplate,
} from "../src/templates";

/** v0.7 C (#5hrsrqsj): Obsidian-compatible templates and daily notes. */

// Friday 2026-03-06, 09:05:07 local time.
const at = new Date(2026, 2, 6, 9, 5, 7);

describe("moment.js date formats (Obsidian settings)", () => {
  it("formats the tokens Obsidian users write", () => {
    expect(formatMomentDate(at, "YYYY-MM-DD")).toBe("2026-03-06");
    expect(formatMomentDate(at, "YY.M.D")).toBe("26.3.6");
    expect(formatMomentDate(at, "dddd, MMMM Do YYYY")).toBe("Friday, March 6th 2026");
    expect(formatMomentDate(at, "ddd D MMM")).toBe("Fri 6 Mar");
    expect(formatMomentDate(at, "HH:mm:ss")).toBe("09:05:07");
    expect(formatMomentDate(new Date(2026, 0, 1, 15, 0), "h:mm A / hh a")).toBe("3:00 PM / 03 pm");
    expect(formatMomentDate(new Date(2026, 0, 1, 0, 30), "h:mm a")).toBe("12:30 am");
    // Literal text in brackets, sub-folders in the format.
    expect(formatMomentDate(at, "[Week of] YYYY/MM/YYYY-MM-DD")).toBe("Week of 2026/03/2026-03-06");
  });

  it("ordinals: 1st 2nd 3rd 4th 11th 12th 13th 21st 22nd", () => {
    const days = [1, 2, 3, 4, 11, 12, 13, 21, 22];
    expect(days.map((d) => formatMomentDate(new Date(2026, 0, d), "Do"))).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd",
    ]);
  });

  it("reads a daily note's name back as its day; rejects other names and impossible days", () => {
    expect(parseMomentDate("2026-03-06", "YYYY-MM-DD")).toBe("2026-03-06");
    expect(parseMomentDate("Friday, March 6th 2026", "dddd, MMMM Do YYYY")).toBe("2026-03-06");
    expect(parseMomentDate("2026/03/2026-03-06", "YYYY/MM/YYYY-MM-DD")).toBe("2026-03-06");
    expect(parseMomentDate("6.3.26", "D.M.YY")).toBe("2026-03-06");
    expect(parseMomentDate("Meeting notes", "YYYY-MM-DD")).toBeNull();
    expect(parseMomentDate("2026-02-31", "YYYY-MM-DD")).toBeNull();
    // The weekday has to be the right one.
    expect(parseMomentDate("Monday, March 6th 2026", "dddd, MMMM Do YYYY")).toBeNull();
  });

  it("dateFromDay accepts real days only", () => {
    expect(dateFromDay("2026-03-06")?.getDate()).toBe(6);
    expect(dateFromDay("2026-13-01")).toBeNull();
    expect(dateFromDay("tomorrow")).toBeNull();
  });
});

describe("template variables (Obsidian core Templates)", () => {
  it("fills title, date and time with the settings' formats", () => {
    expect(
      renderTemplate("# {{title}}\nCreated {{date}} at {{time}}", {
        title: "Weekly review",
        now: at,
        dateFormat: "DD.MM.YYYY",
        timeFormat: "HH:mm",
      }),
    ).toBe("# Weekly review\nCreated 06.03.2026 at 09:05");
  });

  it("custom formats, spaces and case, in frontmatter too; unknown variables stay", () => {
    const text = "---\ncreated: {{ DATE:YYYY-MM-DD }}\n---\n{{date:dddd}} {{time:h a}} {{Title}} {{author}} {{title:x}}";
    expect(renderTemplate(text, { title: "Note", now: at })).toBe(
      "---\ncreated: 2026-03-06\n---\nFriday 9 am Note {{author}} {{title:x}}",
    );
  });

  it("defaults: YYYY-MM-DD and HH:mm", () => {
    expect(renderTemplate("{{date}} {{time}}", { title: "", now: at })).toBe("2026-03-06 09:05");
  });
});

describe("daily note paths", () => {
  it("joins the folder and the formatted name, and reads them back", () => {
    const settings = { folder: "Daily/", format: "YYYY-MM-DD", template: "" };
    expect(dailyNoteId(at, settings)).toBe("Daily/2026-03-06");
    expect(dailyNoteDay("Daily/2026-03-06", settings)).toBe("2026-03-06");
    expect(dailyNoteDay("Daily/Notes", settings)).toBeNull();
    expect(dailyNoteDay("2026-03-06", settings)).toBeNull();
    // Obsidian's default: the vault root.
    expect(dailyNoteId(at, { folder: "", format: "YYYY-MM-DD", template: "" })).toBe("2026-03-06");
    expect(dailyNoteDay("Projects/2026-03-06", { folder: "", format: "YYYY-MM-DD", template: "" })).toBeNull();
  });
});
