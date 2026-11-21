/**
 * The desktop app's menus and dialogs in the interface language (#7h5utv23).
 * Same message files as the web app (`apps/web/src/i18n/*.json`, the
 * `desktop` section), bundled into the main process; plurals and `{{vars}}`
 * work as in the web app's `t()`. Pure Node, so it is unit-tested directly.
 */
import en from "../../web/src/i18n/en.json";
import ru from "../../web/src/i18n/ru.json";

const MESSAGES: Record<string, unknown> = { en, ru };

/** Languages the app ships (the message files present). */
export const DESKTOP_LANGUAGES: readonly string[] = Object.keys(MESSAGES);

function lookup(tree: unknown, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** A saved language if it's shipped, else the system locale's (`ru-RU` → `ru`), else English. */
export function resolveDesktopLanguage(saved: string | null | undefined, systemLocale: string): string {
  if (saved && DESKTOP_LANGUAGES.includes(saved)) return saved;
  const base = systemLocale.toLowerCase().split(/[-_]/)[0] ?? "";
  return DESKTOP_LANGUAGES.includes(base) ? base : "en";
}

/** `desktop.<key>` in `language` (English when missing), with `{{vars}}` and plurals by `count`. */
export function desktopT(language: string, key: string, vars: Record<string, string | number> = {}): string {
  const messages = MESSAGES[language] ?? en;
  const full = `desktop.${key}`;
  let text: string | undefined;
  if (typeof vars.count === "number") {
    const category = new Intl.PluralRules(language).select(vars.count);
    text = lookup(messages, `${full}_${category}`) ?? lookup(messages, `${full}_other`) ?? lookup(en, `${full}_other`);
  }
  text ??= lookup(messages, full) ?? lookup(en, full) ?? full;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (vars[name] === undefined ? match : String(vars[name])));
}
