import { afterAll, describe, expect, it } from "vitest";
import { setLanguage } from "../src/i18n/index.js";
import { addDays, addMonths, formatDateValue, monthGrid, parseDateValue, parseTime, toFileValue, weekStart } from "../src/lib/dates.js";

describe("date property values (#93wnicas)", () => {
  afterAll(async () => {
    await setLanguage("en");
  });

  it("reads the file's formats and rejects what isn't a date", () => {
    expect(parseDateValue("2026-11-21")).toEqual({ year: 2026, month: 11, day: 21 });
    expect(parseDateValue("2026-11-21T14:30")).toEqual({ year: 2026, month: 11, day: 21, hour: 14, minute: 30 });
    expect(parseDateValue("2026-11-21T14:30:00")).toEqual({ year: 2026, month: 11, day: 21, hour: 14, minute: 30 });
    for (const bad of ["", "next week", "2026-02-30", "2026-13-01", "2026-11-21T25:00", 20261121, null]) {
      expect(parseDateValue(bad)).toBeNull();
    }
    expect(parseDateValue("2028-02-29")).not.toBeNull();
  });

  it("shows dates as the app does, in the interface language", async () => {
    await setLanguage("en");
    expect(formatDateValue("2026-11-21")).toBe("Nov 21, 2026");
    expect(formatDateValue("2026-11-21T14:30")).toMatch(/^Nov 21, 2026, 2:30\sPM$/);
    expect(formatDateValue("soon")).toBeNull();
    await setLanguage("ru");
    expect(formatDateValue("2026-11-21")).toBe("21 нояб. 2026 г.");
    expect(formatDateValue("2026-11-21T14:30")).toMatch(/^21 нояб\. 2026 г\., 14:30$/);
  });

  it("writes exactly what the native inputs wrote", () => {
    expect(toFileValue({ year: 2026, month: 11, day: 5 }, false)).toBe("2026-11-05");
    expect(toFileValue({ year: 2026, month: 11, day: 5, hour: 14, minute: 30 }, false)).toBe("2026-11-05");
    expect(toFileValue({ year: 2026, month: 11, day: 5, hour: 9, minute: 5 }, true)).toBe("2026-11-05T09:05");
    expect(toFileValue({ year: 2026, month: 11, day: 5 }, true)).toBe("2026-11-05T00:00");
    for (const value of ["2026-01-01", "2028-02-29", "0999-12-31"]) expect(toFileValue(parseDateValue(value)!, false)).toBe(value);
    expect(toFileValue(parseDateValue("2026-11-21T07:45")!, true)).toBe("2026-11-21T07:45");
  });

  it("lays out a month as 6 weeks from the language's first weekday", () => {
    // February 2028 (a leap year) starts on a Tuesday.
    const monday = monthGrid(2028, 2, 1);
    expect(monday).toHaveLength(42);
    expect(monday[0]).toEqual({ year: 2028, month: 1, day: 31, inMonth: false });
    expect(monday[1]).toEqual({ year: 2028, month: 2, day: 1, inMonth: true });
    expect(monday.filter((cell) => cell.inMonth)).toHaveLength(29);
    const sunday = monthGrid(2028, 2, 0);
    expect(sunday[0]).toEqual({ year: 2028, month: 1, day: 30, inMonth: false });
    expect(sunday[2]).toEqual({ year: 2028, month: 2, day: 1, inMonth: true });
    // November 2026 starts on a Sunday: no spill-over row on a Sunday-first grid.
    expect(monthGrid(2026, 11, 0)[0]).toEqual({ year: 2026, month: 11, day: 1, inMonth: true });
    expect(monthGrid(2026, 11, 1)[6]).toEqual({ year: 2026, month: 11, day: 1, inMonth: true });
    expect(weekStart("en")).toBe(0);
    expect(weekStart("ru")).toBe(1);
  });

  it("moves by days and months as the keyboard does", () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 3, day: 1, hour: 8, minute: 0 }, -7)).toEqual({ year: 2026, month: 2, day: 22, hour: 8, minute: 0 });
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addMonths({ year: 2026, month: 1, day: 15 }, -1)).toEqual({ year: 2025, month: 12, day: 15 });
    expect(addMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({ year: 2027, month: 1, day: 15 });
  });

  it("reads 24-hour times only", () => {
    expect(parseTime("14:30")).toEqual({ hour: 14, minute: 30 });
    expect(parseTime(" 9:05 ")).toEqual({ hour: 9, minute: 5 });
    for (const bad of ["24:00", "12:60", "2pm", "1430", ""]) expect(parseTime(bad)).toBeNull();
  });
});
