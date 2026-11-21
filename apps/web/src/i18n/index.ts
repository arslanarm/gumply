/**
 * Translations (D32, #7h5utv23). A small in-house `t()` over message files in
 * the i18next JSON v4 format, so translation tools read them and a switch to
 * i18next later is a drop-in:
 *
 * - nested keys by area: `t("sidebar.newPage")`;
 * - `{{name}}` interpolation: `t("delete.title", { title })`;
 * - plurals as `key_one`/`key_few`/`key_many`/`key_other`, chosen with
 *   `Intl.PluralRules` from `count`: `t("delete.subPages", { count: 3 })`.
 *
 * English is bundled and is the fallback for anything missing; other
 * languages are separate chunks, loaded before first paint only when chosen.
 * Keys are typed from `en.json`, so a typo fails the typecheck.
 *
 * Non-React code calls `t()` when it runs (never at import), so it always
 * uses the current language. React components use `useT()`, which re-renders
 * them when the language changes.
 */
import { useSyncExternalStore } from "react";
import en from "./en.json";

export type Messages = typeof en;

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
type WithoutPlural<K> = K extends `${infer Base}_${PluralCategory}` ? Base : K;

/** Every message key in `en.json`; plural keys without their `_one`/`_other` suffix. */
export type MessageKey = WithoutPlural<Leaves<Messages>>;
export type MessageVars = Record<string, string | number>;

/** The languages Gumply ships, each named in itself (for the picker). */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ru", name: "Русский" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];
/** A saved preference: a language, or "system" to follow the browser/OS. */
export type LanguagePreference = Language | "system";

export const LANGUAGE_STORAGE_KEY = "gumply:language";

type Loader = () => Promise<{ default: unknown }>;
const LOADERS: Record<Exclude<Language, "en">, Loader> = {
  ru: () => import("./ru.json"),
};

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return isLanguage(value) ? value : "system";
}

/** The first shipped language among the user's preferred ones (`ru-RU` → `ru`), else English. */
export function detectLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

export function resolveLanguage(preference: LanguagePreference, preferred: readonly string[]): Language {
  return preference === "system" ? detectLanguage(preferred) : preference;
}

/** Flatten nested messages to `a.b.c` keys. */
export function flattenMessages(tree: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (tree && typeof tree === "object") {
    for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "string") out.set(path, value);
      else flattenMessages(value, path, out);
    }
  }
  return out;
}

const english = flattenMessages(en);
let language: Language = "en";
let messages: Map<string, string> = english;
let plurals = new Intl.PluralRules("en");
const listeners = new Set<() => void>();

export function currentLanguage(): Language {
  return language;
}

/** The active locale for `Intl` formatters. */
export function currentLocale(): string {
  return language;
}

function lookup(key: string): string | undefined {
  return messages.get(key) ?? english.get(key);
}

function interpolate(text: string, vars: MessageVars | undefined): string {
  if (!vars) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return typeof value === "number" ? new Intl.NumberFormat(language).format(value) : value;
  });
}

/**
 * The message for `key` in the current language (English when missing),
 * with `{{vars}}` filled in. With a numeric `count`, the plural form the
 * language needs is chosen (`_one`, `_few`, `_many`, `_other`).
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  let text: string | undefined;
  const count = vars?.count;
  if (typeof count === "number") {
    const category = plurals.select(count);
    text =
      messages.get(`${key}_${category}`) ??
      messages.get(`${key}_other`) ??
      english.get(`${key}_${new Intl.PluralRules("en").select(count)}`) ??
      english.get(`${key}_other`);
  }
  text ??= lookup(key);
  return interpolate(text ?? key, vars);
}

/** "a, b and c" in the current language (no serial comma in any shipped language). */
export function listJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(t("common.listComma"))}${t("common.listAnd")}${parts[parts.length - 1]}`;
}

/** Load (if needed) and switch to `next`; components using `useT()` re-render. */
export async function setLanguage(next: Language): Promise<void> {
  const loaded = next === "en" ? english : flattenMessages((await LOADERS[next]()).default);
  language = next;
  messages = loaded;
  plurals = new Intl.PluralRules(next);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `t` for components: re-renders the component when the language changes.
 * Returns the same `t`, so it can be passed down and used in callbacks.
 */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
  return t;
}

/** The current language, as React state. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
}

/* ------------------------------------------------------------------------ */
/* Dates and times                                                           */
/* ------------------------------------------------------------------------ */

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** A cached `Intl.DateTimeFormat` for the current language. */
export function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${language}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(language, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** "just now", "5 min ago", "3 h ago", then a short date, in the current language. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return t("time.recently");
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  return dateFormat({ month: "short", day: "numeric" }).format(time);
}
