import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  flattenMessages,
  LANGUAGES,
  parseLanguagePreference,
  resolveLanguage,
  setLanguage,
  t,
} from "../src/i18n/index";

const dir = new URL("../src/i18n/", import.meta.url);
const read = (file: string) => flattenMessages(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
const english = read("en.json");
const locales = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "en.json");

/** Messages that may read the same in every language: names, and pure templates (A3). */
const SAME_IN_EVERY_LANGUAGE = new Set(["app.name", "settings.mcp.claudeCode", "settings.mcp.claudeDesktop", "settings.mcp.recentRow", "notionImport.chosen"]);

/** A key without its plural suffix. */
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();

describe("message files (#7h5utv23): every language has exactly the English keys", () => {
  it("ships a file for every language in the picker, and nothing else", () => {
    expect(locales.map((file) => file.replace(".json", "")).sort()).toEqual(
      LANGUAGES.map((language) => language.code).filter((code) => code !== "en").sort(),
    );
  });

  for (const file of locales) {
    const code = file.replace(".json", "");
    const messages = read(file);
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

    describe(code, () => {
      it("has no missing keys (plurals count by their base key)", () => {
        const have = new Set([...messages.keys()].map(base));
        const missing = [...new Set([...english.keys()].map(base))].filter((key) => !have.has(key));
        expect(missing).toEqual([]);
      });

      it("has no extra keys", () => {
        const known = new Set([...english.keys()].map(base));
        const extra = [...messages.keys()].filter((key) => !known.has(base(key)));
        expect(extra).toEqual([]);
      });

      it(`has every plural form ${code} needs (${categories.join(", ")})`, () => {
        const plurals = new Set([...english.keys()].filter((key) => key !== base(key)).map(base));
        const missing: string[] = [];
        for (const key of plurals) {
          for (const category of categories) if (!messages.has(`${key}_${category}`)) missing.push(`${key}_${category}`);
        }
        expect(missing).toEqual([]);
      });

      it("keeps every {{placeholder}} of the English text", () => {
        const wrong: string[] = [];
        for (const [key, text] of messages) {
          const source = english.get(key) ?? english.get(`${base(key)}_other`);
          if (source !== undefined && placeholders(source).join() !== placeholders(text).join()) wrong.push(key);
        }
        expect(wrong).toEqual([]);
      });

      it("translates everything: nothing copied from English except names and punctuation", () => {
        const copied = [...messages].filter(
          ([key, text]) => text.trim() !== "" && text === english.get(key) && !SAME_IN_EVERY_LANGUAGE.has(key) && /[A-Za-z]{2}/.test(text),
        );
        expect(copied.map(([key]) => key)).toEqual([]);
      });

      it("translates everything (empty only where English is empty too)", () => {
        const empty = [...messages].filter(([key, text]) => text.trim() === "" && (english.get(key) ?? "x").trim() !== "");
        expect(empty.map(([key]) => key)).toEqual([]);
      });
    });
  }
});

describe("t() (#7h5utv23)", () => {
  it("fills {{vars}} and picks Russian plural forms", async () => {
    await setLanguage("en");
    expect(t("delete.subPages", { count: 1 })).toBe("Its 1 sub-page will be deleted too.");
    expect(t("delete.subPages", { count: 3 })).toBe("Its 3 sub-pages will be deleted too.");
    expect(t("delete.title", { title: "Plan" })).toBe("Delete “Plan”?");
    await setLanguage("ru");
    const forms = [1, 2, 5, 21, 22, 25, 11].map((count) => t("graph.pages", { count }));
    // one, few, many, one, few, many, many: three distinct endings.
    expect(new Set(forms.map((text) => text.replace(/^\d+ /, ""))).size).toBe(3);
    expect(forms[0]!.replace(/^\d+ /, "")).toBe(forms[3]!.replace(/^\d+ /, ""));
    await setLanguage("en");
  });

  it("detects the language from the browser's list", () => {
    expect(detectLanguage(["ru-RU", "en-US"])).toBe("ru");
    expect(detectLanguage(["de-DE", "en-GB"])).toBe("en");
    expect(detectLanguage([])).toBe("en");
    expect(resolveLanguage("system", ["ru"])).toBe("ru");
    expect(resolveLanguage("en", ["ru"])).toBe("en");
    expect(parseLanguagePreference("ru")).toBe("ru");
    expect(parseLanguagePreference("xx")).toBe("system");
  });
});
