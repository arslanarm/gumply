/**
 * Page templates and daily notes (v0.7 C, #5hrsrqsj), compatible with
 * Obsidian's core Templates and Daily notes plugins.
 *
 * - Template variables: `{{title}}`, `{{date}}`, `{{time}}`, and
 *   `{{date:FORMAT}}` / `{{time:FORMAT}}` with moment.js tokens, anywhere in
 *   the file (frontmatter included), like Obsidian.
 * - Dates use the moment.js tokens Obsidian users write in settings and
 *   templates, with English names (Obsidian's default locale), so a daily
 *   note's file name is the same in both apps.
 */

/** Obsidian's `.obsidian/templates.json` (Gumply: `.gumply/templates.json`). */
export interface TemplateSettings {
  /** Vault folder of the templates, no trailing slash. */
  folder: string;
  dateFormat: string;
  timeFormat: string;
}

/** Obsidian's `.obsidian/daily-notes.json` (Gumply: `.gumply/daily-notes.json`). */
export interface DailyNoteSettings {
  /** Vault folder of the daily notes ("" = top level). */
  folder: string;
  /** moment.js format of the file name (may contain `/` for sub-folders). */
  format: string;
  /** Template note path without `.md` ("" = none). */
  template: string;
}

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = {
  folder: "Templates",
  dateFormat: "YYYY-MM-DD",
  timeFormat: "HH:mm",
};

export const DEFAULT_DAILY_SETTINGS: DailyNoteSettings = {
  folder: "Daily",
  format: "YYYY-MM-DD",
  template: "",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Longest first, so `MMMM` wins over `MM` and `M`. */
const TOKENS = [
  "YYYY", "YY",
  "MMMM", "MMM", "MM", "M",
  "Do", "DD", "D",
  "dddd", "ddd", "dd", "d",
  "HH", "H", "hh", "h",
  "mm", "m", "ss", "s",
  "A", "a",
] as const;
type Token = (typeof TOKENS)[number];

type Part = { token: Token } | { text: string };

function tokenize(format: string): Part[] {
  const parts: Part[] = [];
  let text = "";
  const flush = () => {
    if (text) parts.push({ text });
    text = "";
  };
  for (let i = 0; i < format.length; ) {
    if (format[i] === "[") {
      const end = format.indexOf("]", i + 1);
      if (end !== -1) {
        text += format.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    const token = TOKENS.find((candidate) => format.startsWith(candidate, i));
    if (token) {
      flush();
      parts.push({ token });
      i += token.length;
    } else {
      text += format[i];
      i += 1;
    }
  }
  flush();
  return parts;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

function formatToken(token: Token, date: Date): string {
  const hours = date.getHours();
  switch (token) {
    case "YYYY": return pad(date.getFullYear(), 4);
    case "YY": return pad(date.getFullYear() % 100);
    case "MMMM": return MONTHS[date.getMonth()]!;
    case "MMM": return MONTHS[date.getMonth()]!.slice(0, 3);
    case "MM": return pad(date.getMonth() + 1);
    case "M": return String(date.getMonth() + 1);
    case "Do": return ordinal(date.getDate());
    case "DD": return pad(date.getDate());
    case "D": return String(date.getDate());
    case "dddd": return WEEKDAYS[date.getDay()]!;
    case "ddd": return WEEKDAYS[date.getDay()]!.slice(0, 3);
    case "dd": return WEEKDAYS[date.getDay()]!.slice(0, 2);
    case "d": return String(date.getDay());
    case "HH": return pad(hours);
    case "H": return String(hours);
    case "hh": return pad(hours % 12 || 12);
    case "h": return String(hours % 12 || 12);
    case "mm": return pad(date.getMinutes());
    case "m": return String(date.getMinutes());
    case "ss": return pad(date.getSeconds());
    case "s": return String(date.getSeconds());
    case "A": return hours < 12 ? "AM" : "PM";
    case "a": return hours < 12 ? "am" : "pm";
  }
}

/** Format a local date with moment.js tokens (`[text]` is literal). */
export function formatMomentDate(date: Date, format: string): string {
  return tokenize(format)
    .map((part) => ("token" in part ? formatToken(part.token, date) : part.text))
    .join("");
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const TOKEN_PATTERNS: Record<Token, string> = {
  YYYY: "(\\d{4})", YY: "(\\d{2})",
  MMMM: `(${MONTHS.join("|")})`, MMM: `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`,
  MM: "(\\d{2})", M: "(\\d{1,2})",
  Do: "(\\d{1,2})(?:st|nd|rd|th)", DD: "(\\d{2})", D: "(\\d{1,2})",
  dddd: `(?:${WEEKDAYS.join("|")})`, ddd: `(?:${WEEKDAYS.map((d) => d.slice(0, 3)).join("|")})`,
  dd: `(?:${WEEKDAYS.map((d) => d.slice(0, 2)).join("|")})`, d: "(?:\\d)",
  HH: "(?:\\d{2})", H: "(?:\\d{1,2})", hh: "(?:\\d{2})", h: "(?:\\d{1,2})",
  mm: "(?:\\d{2})", m: "(?:\\d{1,2})", ss: "(?:\\d{2})", s: "(?:\\d{1,2})",
  A: "(?:AM|PM)", a: "(?:am|pm)",
};

/** Tokens whose pattern captures a part of the date (the others only match). */
const DATE_FIELDS = new Set<Token>(["YYYY", "YY", "MMMM", "MMM", "MM", "M", "Do", "DD", "D"]);

/**
 * The calendar day a name written with `format` stands for, as `YYYY-MM-DD`,
 * or null when it isn't one (a daily note's file name → its date).
 */
export function parseMomentDate(name: string, format: string): string | null {
  const parts = tokenize(format);
  let pattern = "";
  const fields: Token[] = [];
  for (const part of parts) {
    if ("text" in part) {
      pattern += escapeRegExp(part.text);
      continue;
    }
    pattern += TOKEN_PATTERNS[part.token];
    if (DATE_FIELDS.has(part.token)) fields.push(part.token);
  }
  const match = new RegExp(`^${pattern}$`).exec(name);
  if (!match) return null;
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  fields.forEach((token, index) => {
    const value = match[index + 1] ?? "";
    if (token === "YYYY") year = Number(value);
    else if (token === "YY") year = 2000 + Number(value);
    else if (token === "MMMM") month = MONTHS.indexOf(value) + 1;
    else if (token === "MMM") month = MONTHS.findIndex((m) => m.startsWith(value)) + 1;
    else if (token === "MM" || token === "M") month = Number(value);
    else if (token === "Do" || token === "DD" || token === "D") day = Number(value);
  });
  if (year === null || month === null || day === null) return null;
  const date = new Date(year, (month as number) - 1, day);
  // Reject impossible days (2026-02-31) and names that format differently.
  if (formatMomentDate(date, format) !== name) return null;
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` → a local date at midnight, or null. */
export function dateFromDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatMomentDate(date, "YYYY-MM-DD") === day ? date : null;
}

export interface TemplateContext {
  title: string;
  now: Date;
  dateFormat?: string;
  timeFormat?: string;
}

/**
 * Fill a template's variables, like Obsidian's core Templates plugin:
 * `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}`
 * (case-insensitive, spaces allowed inside the braces). Anything else in
 * `{{…}}` is left as written.
 */
export function renderTemplate(text: string, context: TemplateContext): string {
  const dateFormat = context.dateFormat || DEFAULT_TEMPLATE_SETTINGS.dateFormat;
  const timeFormat = context.timeFormat || DEFAULT_TEMPLATE_SETTINGS.timeFormat;
  return text.replace(/{{\s*(title|date|time)\s*(?::([^}]*))?}}/gi, (whole, name: string, format?: string) => {
    const key = name.toLowerCase();
    if (key === "title") return format === undefined ? context.title : whole;
    const custom = format?.trim();
    return formatMomentDate(context.now, custom || (key === "date" ? dateFormat : timeFormat));
  });
}

/** Where a day's note lives: the vault path without `.md`. */
export function dailyNoteId(day: Date, settings: DailyNoteSettings): string {
  const name = formatMomentDate(day, settings.format || DEFAULT_DAILY_SETTINGS.format);
  const folder = settings.folder.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${name}` : name;
}

/** The day (`YYYY-MM-DD`) a page id stands for as a daily note, or null. */
export function dailyNoteDay(id: string, settings: DailyNoteSettings): string | null {
  const folder = settings.folder.replace(/^\/+|\/+$/g, "");
  if (folder && !id.startsWith(`${folder}/`)) return null;
  const name = folder ? id.slice(folder.length + 1) : id;
  return parseMomentDate(name, settings.format || DEFAULT_DAILY_SETTINGS.format);
}
