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
  en: ["en-US", "en-GB", "en"],
  ru: ["ru", "ru-RU"],
};

/** The best dictionary `available` has for `tag` (a language or a locale like `en-GB`), or null. */
function dictionaryFor(tag: string, available: readonly string[]): string | null {
  const lower = new Map(available.map((code) => [code.toLowerCase(), code]));
  const exact = lower.get(tag.toLowerCase());
  if (exact) return exact;
  const base = tag.toLowerCase().split(/[-_]/)[0] ?? "";
  for (const code of PREFERRED[base] ?? [base]) {
    const match = lower.get(code.toLowerCase());
    if (match) return match;
  }
  return available.find((code) => code.toLowerCase().split(/[-_]/)[0] === base) ?? null;
}

/**
 * The spellcheck languages: the app's (`uiLanguage`, e.g. `ru`), then the
 * system locale's (e.g. `en-GB`) when its language differs. Empty when
 * Chromium offers neither.
 */
export function spellcheckLanguages(uiLanguage: string, systemLocale: string, available: readonly string[]): string[] {
  const out: string[] = [];
  const first = dictionaryFor(uiLanguage, available);
  if (first) out.push(first);
  const uiBase = uiLanguage.toLowerCase().split(/[-_]/)[0];
  const systemBase = systemLocale.toLowerCase().split(/[-_]/)[0];
  if (systemLocale && systemBase !== uiBase) {
    const second = dictionaryFor(systemLocale, available);
    if (second && !out.includes(second)) out.push(second);
  }
  return out;
}
