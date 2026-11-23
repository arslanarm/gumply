/**
 * D47 (#xhdjpaev): this installation's id, so a rename's crash journal (in the
 * vault, which may be synced) is finished by the device that started it.
 * Kept in app data, never in the vault:
 * - desktop: `<userData>/instance-id` (Electron's app data folder);
 * - the standalone server: `<state dir>/gumply/instance-id`, where the state dir is
 *   `$XDG_STATE_HOME` or `~/.local/state` (Linux), `~/Library/Application Support`
 *   (macOS), `%LOCALAPPDATA%` (Windows); `GUMPLY_INSTANCE_ID` overrides it.
 * If it can't be read or written, a fresh id for this run is used (a recent
 * journal entry is then left for 7 days, then finished by any installation).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ID = /^[A-Za-z0-9-]{8,64}$/;

/** The id stored in `folder/instance-id`, created on first use. */
export function loadInstanceId(folder: string): string {
  const file = join(folder, "instance-id");
  try {
    const stored = readFileSync(file, "utf8").trim();
    if (ID.test(stored)) return stored;
  } catch {
    // none yet
  }
  const id = randomUUID();
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {
    // Not writable: this run's id only.
  }
  return id;
}

/** The standalone server's own state folder (never the vault). */
export function serverStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Gumply");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Gumply");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "gumply");
}

/** The standalone server's id: GUMPLY_INSTANCE_ID, else the one in its state folder. */
export function serverInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GUMPLY_INSTANCE_ID?.trim();
  if (fromEnv && ID.test(fromEnv)) return fromEnv;
  return loadInstanceId(serverStateDir(env));
}
