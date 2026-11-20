import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSettings,
  MAX_RECENT_VAULTS,
  normaliseSettings,
  saveSettings,
  SETTINGS_FILE,
  withOpenedVault,
  withoutRecentVault,
} from "../src/settings";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "gumply-desktop-settings-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("desktop settings (D26)", () => {
  it("starts empty and round-trips through the settings file", () => {
    const dir = temp();
    expect(loadSettings(dir)).toEqual({ lastVault: null, recentVaults: [], window: null });
    const next = withOpenedVault(loadSettings(dir), "/home/me/Notes");
    saveSettings(dir, { ...next, window: { x: 10, y: 20, width: 1000, height: 700, maximized: false } });
    expect(loadSettings(dir)).toEqual({
      lastVault: "/home/me/Notes",
      recentVaults: ["/home/me/Notes"],
      window: { x: 10, y: 20, width: 1000, height: 700, maximized: false },
    });
    expect(readFileSync(join(dir, SETTINGS_FILE), "utf8").endsWith("\n")).toBe(true);
  });

  it("keeps Recent unique, most recent first, and capped", () => {
    let settings = loadSettings(temp());
    for (let i = 0; i < MAX_RECENT_VAULTS + 3; i += 1) settings = withOpenedVault(settings, `/v${i}`);
    settings = withOpenedVault(settings, "/v5");
    expect(settings.recentVaults[0]).toBe("/v5");
    expect(settings.recentVaults).toHaveLength(MAX_RECENT_VAULTS);
    expect(new Set(settings.recentVaults).size).toBe(MAX_RECENT_VAULTS);
    expect(settings.lastVault).toBe("/v5");
  });

  it("forgets a missing vault, or clears Recent", () => {
    const settings = withOpenedVault(withOpenedVault(loadSettings(temp()), "/a"), "/b");
    expect(withoutRecentVault(settings, "/b")).toMatchObject({ lastVault: null, recentVaults: ["/a"] });
    expect(withoutRecentVault(settings, "/a")).toMatchObject({ lastVault: "/b", recentVaults: ["/b"] });
    expect(withoutRecentVault(settings)).toMatchObject({ lastVault: "/b", recentVaults: [] });
  });

  it("survives a damaged or hand-edited file", () => {
    const dir = temp();
    writeFileSync(join(dir, SETTINGS_FILE), "{ not json");
    expect(loadSettings(dir)).toEqual({ lastVault: null, recentVaults: [], window: null });
    expect(
      normaliseSettings({
        lastVault: 42,
        recentVaults: ["/a", 7, "", "/a", "/b"],
        window: { width: 100, height: "x" },
      }),
    ).toEqual({ lastVault: null, recentVaults: ["/a", "/b"], window: null });
    expect(normaliseSettings({ window: { width: 50.6, height: 80, x: 1.2 } }).window).toEqual({
      width: 400,
      height: 300,
      maximized: false,
    });
  });
});
