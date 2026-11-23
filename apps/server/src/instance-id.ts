/**
 * D47 (#xhdjpaev): this installation's id, so a rename's crash journal (in the
 * vault, which may be synced) is finished by the device that started it.
 * Kept in app data, never in the vault:
 * - desktop: `<userData>/instance-id` (Electron's app data folder);
 * - the standalone server: `<state dir>/gumply/instance-id`, where the state dir is
 *   `$XDG_STATE_HOME` or `~/.local/state` (Linux), `~/Library/Application Support`
 *   (macOS), `%LOCALAPPDATA%` (Windows); `GUMPLY_INSTANCE_ID` overrides it.
 * The file is only created when a rename writes its first journal entry: a
 * start (or a run that renames nothing) writes nothing to app data. If it can't
 * be written, a fresh id for this run is used (a recent journal entry is then
 * left for 7 days, then finished by any installation).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ID = /^[A-Za-z0-9-]{8,64}$/;

/** The id stored in `folder/instance-id`, or null when there is none (nothing is created). */
export function peekInstanceId(folder: string): string | null {
  try {
    const stored = readFileSync(join(folder, "instance-id"), "utf8").trim();
    return ID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The id stored in `folder/instance-id`, created on first use. */
export function loadInstanceId(folder: string): string {
  const stored = peekInstanceId(folder);
  if (stored) return stored;
  const id = randomUUID();
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "instance-id"), `${id}\n`, { mode: 0o600 });
  } catch {
    // Not writable: this run's id only.
  }
  return id;
}

/**
 * This installation's id, created lazily (#xhdjpaev review): `peek` reads it and
 * creates nothing (a start writes nothing to app data); `ensure` creates it, and
 * is only called when a rename writes its first journal entry.
 */
export interface InstanceId {
  peek(): string | null;
  ensure(): string;
}

/** The id kept in `folder` (desktop: Electron's userData). */
export function instanceIdIn(folder: string): InstanceId {
  let created: string | null = null;
  return {
    peek: () => created ?? peekInstanceId(folder),
    ensure: () => (created ??= loadInstanceId(folder)),
  };
}

/** A fixed id (GUMPLY_INSTANCE_ID, tests). */
export function fixedInstanceId(id: string): InstanceId {
  return { peek: () => id, ensure: () => id };
}

/** The standalone server's own state folder (never the vault). */
export function serverStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Gumply");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Gumply");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "gumply");
}

/** The standalone server's id: GUMPLY_INSTANCE_ID, else the one in its state folder (created lazily). */
export function serverInstanceId(env: NodeJS.ProcessEnv = process.env): InstanceId {
  const fromEnv = env.GUMPLY_INSTANCE_ID?.trim();
  if (fromEnv && ID.test(fromEnv)) return fixedInstanceId(fromEnv);
  return instanceIdIn(serverStateDir(env));
}
