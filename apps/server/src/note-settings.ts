/**
 * Template and daily-note settings (v0.7 C, #5hrsrqsj). Read-only.
 *
 * An Obsidian vault already carries them: `.obsidian/templates.json` and
 * `.obsidian/daily-notes.json`, written by Obsidian's core plugins. Gumply
 * never writes into `.obsidian/`. Without those files, `.gumply/` holds the
 * same shapes; without either, the defaults apply.
 *
 * As in Obsidian, a settings file that leaves a key out (or empty) means that
 * plugin's own default, e.g. daily notes at the vault root.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_DAILY_SETTINGS,
  DEFAULT_TEMPLATE_SETTINGS,
  type DailyNoteSettings,
  type TemplateSettings,
} from "@gumply/core";

/** Where the settings were read from (shown in the docs and tests). */
export type SettingsSource = "obsidian" | "gumply" | "default";

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A vault folder or note path as written in settings: no leading/trailing `/`, no `.md`. */
function vaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
}

async function settingsFile(root: string, name: string): Promise<{ data: Record<string, unknown>; source: SettingsSource } | null> {
  const obsidian = await readJson(join(root, ".obsidian", name));
  if (obsidian) return { data: obsidian, source: "obsidian" };
  const gumply = await readJson(join(root, ".gumply", name));
  if (gumply) return { data: gumply, source: "gumply" };
  return null;
}

export async function readTemplateSettings(root: string): Promise<TemplateSettings & { source: SettingsSource }> {
  const file = await settingsFile(root, "templates.json");
  if (!file) return { ...DEFAULT_TEMPLATE_SETTINGS, source: "default" };
  return {
    // Obsidian's Templates plugin has no folder until one is set; ours is `Templates`.
    folder: vaultPath(text(file.data.folder)) || DEFAULT_TEMPLATE_SETTINGS.folder,
    dateFormat: text(file.data.dateFormat) || DEFAULT_TEMPLATE_SETTINGS.dateFormat,
    timeFormat: text(file.data.timeFormat) || DEFAULT_TEMPLATE_SETTINGS.timeFormat,
    source: file.source,
  };
}

export async function readDailySettings(root: string): Promise<DailyNoteSettings & { source: SettingsSource }> {
  const file = await settingsFile(root, "daily-notes.json");
  if (!file) return { ...DEFAULT_DAILY_SETTINGS, source: "default" };
  return {
    // Obsidian: no folder = the vault root.
    folder: vaultPath(text(file.data.folder)),
    format: text(file.data.format) || DEFAULT_DAILY_SETTINGS.format,
    template: vaultPath(text(file.data.template)),
    source: file.source,
  };
}
