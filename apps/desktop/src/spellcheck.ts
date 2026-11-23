/**
 * Spellcheck follows the app's language (1.0 gap N3). Chromium's spellchecker
 * checks in the system's language unless told otherwise, so someone writing
 * Russian on an English system (or the reverse) got the wrong dictionary. The
 * app's interface language comes first, then the system's own when it's a
 * different language. Only dictionaries Chromium offers are returned.
 *
 * macOS uses the system spellchecker, which picks languages itself; Electron
 * ignores the setting there, so the caller skips it.
 */

/** The dictionary Chromium names for each interface language, in order of preference. */
const PREFERRED: Record<string, readonly string[]> = {
  en: ["en-US", "en-GB", "en-AU", "en-CA", "en"],
  ru: ["ru", "ru-RU"],
};

/**
 * The best dictionary `available` has for `tag`, or null. A locale with a
 * region (`en-GB`) matches itself first; a bare language (`en`, the app's
 * interface language) goes by the preference list, so a regional dictionary
 * wins over a bare `en` entry if Chromium lists one.
 */
function dictionaryFor(tag: string, available: readonly string[]): string | null {
  const lower = new Map(available.map((code) => [code.toLowerCase(), code]));
  const normal = tag.toLowerCase().replace(/_/g, "-");
  const base = normal.split("-")[0] ?? "";
  if (normal !== base) {
    const exact = lower.get(normal);
    if (exact) return exact;
  }
  for (const code of PREFERRED[base] ?? [base]) {
    const match = lower.get(code.toLowerCase());
    if (match) return match;
  }
  return available.find((code) => code.toLowerCase().split(/[-_]/)[0] === base) ?? null;
}

/**
 * The spellcheck languages: the app's (`uiLanguage`, e.g. `ru`), then the
 * system locale's (e.g. `en-GB`) when its language differs. When they're the
 * same language, the system's region is used (English on a UK system checks
 * British spelling). Empty when Chromium offers neither.
 */
export function spellcheckLanguages(uiLanguage: string, systemLocale: string, available: readonly string[]): string[] {
  const out: string[] = [];
  const uiBase = uiLanguage.toLowerCase().split(/[-_]/)[0];
  const systemBase = systemLocale.toLowerCase().split(/[-_]/)[0];
  const sameLanguage = systemLocale !== "" && systemBase === uiBase;
  const first = dictionaryFor(sameLanguage ? systemLocale : uiLanguage, available);
  if (first) out.push(first);
  if (systemLocale && !sameLanguage) {
    const second = dictionaryFor(systemLocale, available);
    if (second && !out.includes(second)) out.push(second);
  }
  return out;
}
