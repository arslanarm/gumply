/**
 * Desktop settings (D26): the last and recent vaults and the window state.
 * Stored as JSON in Electron's `userData` directory, never in a vault.
 * Pure Node (no Electron import) so it is unit-tested directly.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseUiState, type UiState } from "../../server/src/ui-state.js";

export const SETTINGS_FILE = "gumply-desktop.json";
export const MAX_RECENT_VAULTS = 10;

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface DesktopSettings {
  lastVault: string | null;
  recentVaults: string[];
  window: WindowState | null;
  /** The web app's `gumply:*` preferences (#c7fzzxk8): theme, sidebar, board views… */
  uiState: UiState;
}

export const DEFAULT_SETTINGS: DesktopSettings = { lastVault: null, recentVaults: [], window: null, uiState: {} };

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Keep only well-formed values; a damaged file never stops the app. */
export function normaliseSettings(raw: unknown): DesktopSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS, recentVaults: [], uiState: {} };
  const data = raw as Record<string, unknown>;
  const recentVaults = Array.isArray(data.recentVaults)
    ? [...new Set(data.recentVaults.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(
        0,
        MAX_RECENT_VAULTS,
      )
    : [];
  const lastVault = typeof data.lastVault === "string" && data.lastVault.length > 0 ? data.lastVault : null;

  let window: WindowState | null = null;
  const w = data.window as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && isFiniteNumber(w.width) && isFiniteNumber(w.height)) {
    window = {
      width: Math.max(400, Math.round(w.width)),
      height: Math.max(300, Math.round(w.height)),
      maximized: w.maximized === true,
    };
    if (isFiniteNumber(w.x) && isFiniteNumber(w.y)) {
      window.x = Math.round(w.x);
      window.y = Math.round(w.y);
    }
  }
  return { lastVault, recentVaults, window, uiState: normaliseUiState(data.uiState) };
}

export function loadSettings(dir: string): DesktopSettings {
  try {
    return normaliseSettings(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS, recentVaults: [], uiState: {} };
  }
}

/** Atomic write (temp file + rename) so a crash never leaves half a file. */
export function saveSettings(dir: string, settings: DesktopSettings): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SETTINGS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normaliseSettings(settings), null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

/** Open `vault`: it becomes the last vault and moves to the top of Recent. */
export function withOpenedVault(settings: DesktopSettings, vault: string): DesktopSettings {
  return {
    ...settings,
    lastVault: vault,
    recentVaults: [vault, ...settings.recentVaults.filter((item) => item !== vault)].slice(0, MAX_RECENT_VAULTS),
  };
}

/** Forget one vault (it no longer exists), or clear Recent when `vault` is omitted. */
export function withoutRecentVault(settings: DesktopSettings, vault?: string): DesktopSettings {
  if (vault === undefined) return { ...settings, recentVaults: [] };
  return {
    ...settings,
    recentVaults: settings.recentVaults.filter((item) => item !== vault),
    lastVault: settings.lastVault === vault ? null : settings.lastVault,
  };
}
