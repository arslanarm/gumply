/**
 * Date and datetime property values (#93wnicas): read them as the file
 * writes them (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`), show them in the
 * interface language, lay out a month for the picker, and write them back
 * byte for byte as the native input used to.
 */
import { currentLanguage, dateFormat } from "../i18n/index.js";

export interface DateParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

const VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

/** The date (and time) a property value holds, or null when it isn't a valid one. */
export function parseDateValue(raw: unknown): DateParts | null {
  if (typeof raw !== "string") return null;
  const match = VALUE.exec(raw.trim());
  if (!match) return null;
  const [, y, m, d, h, min] = match;
  const parts: DateParts = { year: Number(y), month: Number(m), day: Number(d) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month)) return null;
  if (h !== undefined && min !== undefined) {
    const hour = Number(h);
    const minute = Number(min);
    if (hour > 23 || minute > 59) return null;
    parts.hour = hour;
    parts.minute = minute;
  }
  return parts;
}

/**
 * A value as the app shows dates, in the interface language: "Nov 21, 2026"
 * / "21 нояб. 2026 г.", with the time when the value has one. Null when the
 * value isn't a date.
 */
export function formatDateValue(raw: unknown): string | null {
  const parts = parseDateValue(raw);
  if (!parts) return null;
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0);
  return parts.hour !== undefined
    ? dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(date)
    : dateFormat({ dateStyle: "medium" }).format(date);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** What the file gets: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` for a datetime (00:00 when no time is set). */
export function toFileValue(parts: DateParts, datetime: boolean): string {
  const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  if (!datetime) return date;
  return `${date}T${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 0 = Sunday … 6 = Saturday: the first day of the week in the interface language. */
export function weekStart(language: string = currentLanguage()): number {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    // Intl counts 1 = Monday … 7 = Sunday. A bare "en" reads as en-US: Sunday.
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
  } catch {
    // Older engines: fall through.
  }
  return language.startsWith("en") ? 0 : 1;
}

export interface GridDay {
  year: number;
  month: number;
  day: number;
  /** In the month shown (not a spill-over day from the month before or after). */
  inMonth: boolean;
}

/** The month as the picker shows it: 6 weeks × 7 days, starting on `firstDay`. */
export function monthGrid(year: number, month: number, firstDay: number): GridDay[] {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() - firstDay + 7) % 7;
  const cells: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month - 1, 1 - lead + i);
    cells.push({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), inMonth: date.getMonth() === month - 1 });
  }
  return cells;
}

/** `parts` moved by a number of days (arrow keys), time kept. */
export function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(parts.year, parts.month - 1, parts.day + days);
  return { ...parts, year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** `parts` moved by months (PageUp/PageDown), the day clamped to the new month's length. */
export function addMonths(parts: DateParts, months: number): DateParts {
  const index = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { ...parts, year, month, day: Math.min(parts.day, daysInMonth(year, month)) };
}

type Day = Pick<DateParts, "year" | "month" | "day">;

export function sameDay(a: Day | null, b: Day | null): boolean {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}

export function todayParts(now: Date = new Date()): DateParts {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** "14:30" or "9:05" → {hour, minute}; null when it isn't a 24-hour time. */
export function parseTime(text: string): { hour: number; minute: number } | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function formatTime(parts: Pick<DateParts, "hour" | "minute">): string {
  return `${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}`;
}
