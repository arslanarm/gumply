import { describe, expect, it } from "vitest";
import { normaliseSettings } from "../src/settings";
import { DESKTOP_LANGUAGES, desktopT, resolveDesktopLanguage } from "../src/i18n";

describe("desktop menus and dialogs in the interface language (#7h5utv23)", () => {
  it("ships the web app's languages", () => {
    expect(DESKTOP_LANGUAGES).toEqual(expect.arrayContaining(["en", "ru"]));
  });

  it("uses the saved language, else the system's, else English", () => {
    expect(resolveDesktopLanguage("ru", "en-US")).toBe("ru");
    expect(resolveDesktopLanguage(null, "ru-RU")).toBe("ru");
    expect(resolveDesktopLanguage(null, "de-DE")).toBe("en");
    expect(resolveDesktopLanguage("xx", "en-GB")).toBe("en");
  });

  it("translates menu labels, keeping the access-key ampersand", () => {
    expect(desktopT("en", "menu.file")).toBe("&File");
    expect(desktopT("ru", "menu.file")).toMatch(/^&/);
    expect(desktopT("ru", "menu.newPage")).not.toBe("New Page");
    // Unknown language or key: English, then the key itself.
    expect(desktopT("xx", "menu.newPage")).toBe("New Page");
    expect(desktopT("en", "menu.nope")).toBe("desktop.menu.nope");
  });

  it("keeps the language in the desktop settings (only a plain code)", () => {
    expect(normaliseSettings({ language: "ru" }).language).toBe("ru");
    expect(normaliseSettings({ language: "../evil" }).language).toBeNull();
    expect(normaliseSettings({}).language).toBeNull();
  });
});
