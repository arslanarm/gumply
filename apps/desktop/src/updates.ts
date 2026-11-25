/**
 * Auto-update (spec/auto-update, D42). Pure Node (no Electron import), so
 * the policy is unit-tested directly; main.ts hands it electron-updater.
 *
 * - **Windows NSIS (per user) and the AppImage:** check, download in the
 *   background, install on the next normal quit, after the save flush.
 * - **The `.deb` and macOS:** check only, and tell the user.
 * - **Never** in `--mcp` mode (main.ts doesn't create a controller there),
 *   never a forced restart, never an rc (`allowPrerelease: false`).
 * - **The AppImage keeps its exact path** (every MCP snippet points at it):
 *   electron-updater's own AppImage install renames versioned file names and
 *   unlinks before it moves, so we replace the file ourselves, atomically.
 * - **Windows never installs while another Gumply process from the install
 *   folder runs** (an AI app's `Gumply.exe --mcp`): the update stays pending.
 * - **Update signing (option B), when main.ts passes `verify`:** a download
 *   becomes `ready` only once its signed SHA256SUMS.txt checks out, else
 *   `verify-failed` and nothing is installed; at quit the file is hashed again
 *   and must still match.
 */
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { basename, dirname, join, sep, win32 } from "node:path";
import type { DesktopUpdatesState, UpdateInstallKind, UpdateMode, UpdateStatus } from "@gumply/core";
import type { UpdateSettings } from "./settings.js";
import { sha256FileSync, type VerifyOutcome } from "./update-signature.js";

export type InstallKind = UpdateInstallKind;
export type { UpdateStatus };

export interface InstallContext {
  platform: NodeJS.Platform | string;
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `APPIMAGE` (AppImage launches only). */
  appImage?: string;
  /** `resources/package-type`, written by electron-builder for Linux packages (`deb`). */
  packageType?: string | null;
  /** `resources/app-update.yml` exists (written when `build.publish` is set). */
  hasUpdateConfig: boolean;
}

/** How this copy of Gumply was installed, as far as updating goes. */
export function installKind(context: InstallContext): InstallKind {
  if (!context.packaged || !context.hasUpdateConfig) return "none";
  if (context.platform === "win32") return "nsis";
  if (context.platform === "darwin") return "mac";
  if (context.platform === "linux") {
    if (context.appImage && context.appImage.startsWith("/")) return "appimage";
    if (context.packageType?.trim() === "deb") return "deb";
  }
  return "none";
}

/** Formats Gumply can update by itself; the others get a notice. */
export const canInstall = (kind: InstallKind): boolean => kind === "nsis" || kind === "appimage";

/** The mode in effect: the saved choice, else automatic where Gumply can install, else notify. */
export function effectiveMode(kind: InstallKind, saved?: UpdateMode): UpdateMode {
  if (kind === "none") return "off";
  const mode = saved ?? (canInstall(kind) ? "auto" : "notify");
  return mode === "auto" && !canInstall(kind) ? "notify" : mode;
}

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASES_URL = "https://github.com/arslanarm/gumply/releases";
/** The only header we add (spec §5): no version, no OS string. */
export const REQUEST_HEADERS = { "User-Agent": "Gumply" } as const;

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${encodeURIComponent(version)}`;
}

// --- the AppImage: same path, atomically -------------------------------------

export type ReplaceFs = Pick<
  typeof nodeFs,
  "accessSync" | "copyFileSync" | "chmodSync" | "openSync" | "fsyncSync" | "closeSync" | "renameSync" | "rmSync" | "constants"
>;

/**
 * Put the verified download at `target` (the AppImage's own path): copy it
 * next to `target` (same filesystem), make it executable, flush it, then
 * rename it over `target`, which is atomic. A crash leaves either the old or
 * the new image, never neither. A folder we can't write to → "read-only".
 */
export function replaceAppImage(downloaded: string, target: string, fs: ReplaceFs = nodeFs): "installed" | "read-only" {
  const folder = dirname(target);
  try {
    fs.accessSync(folder, fs.constants.W_OK);
  } catch {
    return "read-only";
  }
  const temporary = join(folder, `.${basename(target)}.update-${process.pid}`);
  try {
    fs.copyFileSync(downloaded, temporary);
    fs.chmodSync(temporary, 0o755);
    const fd = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "read-only";
    throw error;
  }
  return "installed";
}

// --- Windows: other Gumply processes from the install folder ----------------

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  path: string | null;
}

/** Windows paths compared case-insensitively, with one kind of separator. */
const folded = (path: string) => win32.resolve(path).replace(/[\\/]+/g, "\\").toLowerCase();

/**
 * Processes running from `installDir`, other than `self` and its own
 * children (our GPU/network/renderer helpers end with us). An AI app's
 * `Gumply.exe --mcp` is one of these.
 */
export function othersFromInstallDir(processes: readonly ProcessInfo[], installDir: string, self: number): ProcessInfo[] {
  const root = `${folded(installDir).replace(/\\$/, "")}\\`;
  const ours = new Set([self]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const process of processes) {
      if (!ours.has(process.pid) && ours.has(process.parentPid)) {
        ours.add(process.pid);
        grew = true;
      }
    }
  }
  return processes.filter((process) => !ours.has(process.pid) && process.path !== null && folded(process.path).startsWith(root));
}

/** Every process with its parent and executable (Windows); null when it can't be told. */
export function listWindowsProcesses(run: typeof spawnSync = spawnSync): ProcessInfo[] | null {
  const result = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      path: typeof row.ExecutablePath === "string" ? row.ExecutablePath : null,
    }));
  } catch {
    return null;
  }
}

// --- the controller ------------------------------------------------------------

/** The window's view of it (`GET /api/desktop/updates`). */
export type UpdateState = DesktopUpdatesState;

/** The choices Settings offers for this install. */
export function offeredModes(kind: InstallKind): UpdateMode[] {
  if (kind === "none") return ["off"];
  return canInstall(kind) ? ["auto", "notify", "off"] : ["notify", "off"];
}

/** The part of electron-updater's AppUpdater the controller uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  requestHeaders: Record<string, string> | null;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  /** NSIS: start the installer (silently), return whether it started. */
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
  on(event: "update-available" | "update-not-available" | "update-downloaded" | "error", listener: (arg: never) => void): unknown;
}

export interface ControllerDeps {
  kind: InstallKind;
  currentVersion: string;
  updater: UpdaterLike;
  /** The saved update settings (desktop settings). */
  load(): UpdateSettings | undefined;
  save(next: UpdateSettings): void;
  now?(): Date;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Called on every state change (the window's notice and Settings). */
  onChange?(state: UpdateState): void;
  /** AppImage: `$APPIMAGE`. */
  appImagePath?: string;
  /** Windows: the folder `Gumply.exe` runs from. */
  installDir?: string;
  selfPid?: number;
  listProcesses?(): ProcessInfo[] | null;
  replace?(downloaded: string, target: string): "installed" | "read-only";
  log?(message: string): void;
  /** Test builds only: the first check's delay (default 30 s). */
  firstCheckDelayMs?: number;
  /**
   * Update signing (option B): check a finished download. Absent means no
   * signature check (no keys built in). Must never throw; a rejection counts
   * as a failure.
   */
  verify?(download: { version: string; downloadedFile: string }): Promise<VerifyOutcome>;
  /** The re-hash at quit (default: sha256 of the file). */
  hashFileSync?(path: string): string;
}

export type QuitInstall = "nothing" | "installed" | "pending-running" | "read-only" | "failed" | "verify-failed";

export class UpdateController {
  private state: UpdateState;
  private downloadedFile: string | null = null;
  /** With signing: the sha256 the download verified with (checked again at quit). */
  private verifiedSha256: string | null = null;
  /** With signing: a version whose download didn't verify; not downloaded again automatically. */
  private failedVersion: string | null = null;
  /**
   * A version whose download failed in this session (with the reason): not downloaded
   * again automatically (an automatic check, or switching to automatic), so a failing
   * download can't restart itself; a manual "Check now" clears it and retries.
   */
  private downloadFailed: { version: string | null; error: string } | null = null;
  private timer: unknown = null;
  private checking: Promise<void> | null = null;
  /** #7vyqfcpn: raised on every state change (`DesktopUpdatesState.seq`). */
  private seq = 0;

  constructor(private readonly deps: ControllerDeps) {
    const saved = deps.load();
    this.state = {
      kind: deps.kind,
      mode: effectiveMode(deps.kind, saved?.mode),
      modes: offeredModes(deps.kind),
      status: "idle",
      currentVersion: deps.currentVersion,
      version: null,
      releaseUrl: null,
      lastChecked: saved?.lastChecked ?? null,
      error: null,
    };
    const updater = deps.updater;
    updater.autoDownload = false;
    // We install at our own quit, after the flush and the process check.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.requestHeaders = { ...REQUEST_HEADERS };
    updater.on("update-available", ((info: { version: string }) => this.onAvailable(info.version)) as (arg: never) => void);
    updater.on("update-not-available", (() => this.set({ status: "up-to-date", version: null, releaseUrl: null, error: null })) as (arg: never) => void);
    updater.on("update-downloaded", ((info: { version: string; downloadedFile: string }) => {
      if (!this.deps.verify) {
        this.downloadedFile = info.downloadedFile;
        this.set({ status: "ready", version: info.version, releaseUrl: releaseUrl(info.version), error: null });
        return;
      }
      void this.verifyDownload(info);
    }) as (arg: never) => void);
    updater.on("error", ((error: Error) => {
      this.deps.log?.(`[gumply] update: ${error?.message ?? String(error)}`);
      // A failed download leaves the update on offer; a failed check is an error.
      if (this.state.status === "downloading") this.downloadDidFail(error?.message ?? String(error));
      else if (this.state.status !== "ready") this.set({ status: "error", error: error?.message ?? String(error) });
    }) as (arg: never) => void);
  }

  /** Signing: the download stays "downloading" until it checks out; only then "ready". */
  private async verifyDownload(info: { version: string; downloadedFile: string }): Promise<void> {
    let result: VerifyOutcome;
    try {
      result = await this.deps.verify!(info);
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      this.downloadedFile = info.downloadedFile;
      this.verifiedSha256 = result.sha256;
      this.failedVersion = null;
      this.set({ status: "ready", version: info.version, releaseUrl: releaseUrl(info.version), error: null });
      return;
    }
    if (result.retry) {
      // Couldn't fetch the signed files (offline, timeout, too big): nothing installed,
      // shown like a failed check ("Couldn't check for updates"), tried again at the
      // next check. No failedVersion: this says nothing about the release itself.
      this.deps.log?.(`[gumply] update ${info.version} not verified yet: ${result.reason}`);
      this.downloadedFile = null;
      this.verifiedSha256 = null;
      this.set({ status: "error", version: info.version, releaseUrl: releaseUrl(info.version), error: result.reason });
      return;
    }
    this.failVerification(info.version, result.reason);
  }

  private failVerification(version: string | null, reason: string): void {
    this.deps.log?.(`[gumply] update ${version ?? "?"} not verified: ${reason}`);
    this.downloadedFile = null;
    this.verifiedSha256 = null;
    this.failedVersion = version;
    this.set({ status: "verify-failed", version, releaseUrl: version ? releaseUrl(version) : null, error: reason });
  }

  getState(): UpdateState {
    return { ...this.state, modes: [...this.state.modes], seq: this.seq };
  }

  /** Checks 30 s after start, then once a day (spec §3). Nothing at all when off. */
  start(): void {
    this.schedule(this.deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  setMode(mode: UpdateMode): UpdateState {
    const next = effectiveMode(this.state.kind, mode);
    this.deps.save({ ...this.deps.load(), mode: next });
    this.set({ mode: next });
    // Switching to automatic with an update on offer: fetch it now.
    if (next === "auto" && this.state.status === "available" && this.downloadFailed?.version !== this.state.version) void this.download();
    return this.getState();
  }

  /** A check: automatic ones skip when off; "Check now" always runs. */
  check(manual = false): Promise<void> {
    if (this.state.kind === "none") return Promise.resolve();
    if (!manual && this.state.mode === "off") return Promise.resolve();
    // "Check now" retries a download that failed earlier in this session.
    if (manual) this.downloadFailed = null;
    if (this.state.status === "ready" || this.state.status === "downloading" || this.state.status === "pending-running") return Promise.resolve();
    if (this.checking) return this.checking;
    this.set({ status: "checking", error: null });
    this.checking = this.deps.updater
      .checkForUpdates()
      .then(() => {
        const lastChecked = (this.deps.now?.() ?? new Date()).toISOString();
        this.deps.save({ ...this.deps.load(), lastChecked });
        this.set({ lastChecked });
        // No event fired (e.g. an updater that returned nothing): say so.
        if (this.state.status === "checking") this.set({ status: "up-to-date" });
      })
      .catch((error: unknown) => {
        if (this.state.status === "checking") this.set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /**
   * At quit, after the save flush and after the server closed: install a
   * downloaded update if it's safe to. Never throws.
   */
  installOnQuit(restart = false): QuitInstall {
    if (this.state.status !== "ready" && this.state.status !== "pending-running") return "nothing";
    try {
      // Signing: the file must still be the one that verified (the cache folder is the user's).
      if (this.deps.verify) {
        const hash = this.downloadedFile && this.verifiedSha256 ? (this.deps.hashFileSync ?? sha256FileSync)(this.downloadedFile) : null;
        if (hash === null || hash !== this.verifiedSha256) {
          this.failVerification(this.state.version, "the downloaded file changed after it was verified");
          return "verify-failed";
        }
      }
      if (this.state.kind === "appimage") {
        if (!this.downloadedFile || !this.deps.appImagePath) return "nothing";
        const replace = this.deps.replace ?? replaceAppImage;
        const result = replace(this.downloadedFile, this.deps.appImagePath);
        if (result === "read-only") {
          this.set({ status: "read-only" });
          return "read-only";
        }
        this.set({ status: "installing" });
        return "installed";
      }
      if (this.state.kind === "nsis") {
        const processes = this.deps.listProcesses?.() ?? null;
        const others = processes && this.deps.installDir ? othersFromInstallDir(processes, this.deps.installDir, this.deps.selfPid ?? process.pid) : null;
        // Can't tell, or something still runs from the install folder: keep it for the next quit.
        if (others === null || others.length > 0) {
          this.deps.log?.(`[gumply] update ${this.state.version} pending: ${others === null ? "process list unavailable" : `${others.length} Gumply process(es) still running`}`);
          this.set({ status: "pending-running" });
          return "pending-running";
        }
        if (!this.deps.updater.install(true, restart)) {
          this.set({ status: "install-failed" });
          return "failed";
        }
        this.set({ status: "installing" });
        return "installed";
      }
    } catch (error) {
      this.deps.log?.(`[gumply] update install failed: ${error instanceof Error ? error.message : String(error)}`);
      this.set({ status: "install-failed", error: error instanceof Error ? error.message : String(error) });
      return "failed";
    }
    return "nothing";
  }

  private onAvailable(version: string): void {
    // A version that didn't verify isn't fetched again; a newer one is.
    if (version === this.failedVersion) {
      this.set({ status: "verify-failed", version, releaseUrl: releaseUrl(version) });
      return;
    }
    // A version whose download failed in this session stays on offer, with its error, until "Check now".
    if (this.downloadFailed?.version === version) {
      this.set({ status: "available", version, releaseUrl: releaseUrl(version), error: this.downloadFailed.error });
      return;
    }
    this.set({ status: "available", version, releaseUrl: releaseUrl(version), error: null });
    if (this.state.mode === "auto" && canInstall(this.state.kind)) void this.download();
  }

  private download(): Promise<void> {
    this.set({ status: "downloading" });
    return this.deps.updater.downloadUpdate().then(
      () => undefined,
      (error: unknown) => {
        // Usually reported through the "error" event too, which has then already moved
        // the status on. But electron-updater can reject without emitting it (a sha512
        // mismatch after its differential-download fallback, the v0.9.0 tag build), and
        // the status then stayed "downloading" for good: leave the update on offer.
        if (this.state.status !== "downloading") return;
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`[gumply] update: ${message}`);
        this.downloadDidFail(message);
      },
    );
  }

  /** A download failed: the update stays on offer with the reason, and isn't fetched again automatically. */
  private downloadDidFail(message: string): void {
    this.downloadFailed = { version: this.state.version, error: message };
    this.set({ status: "available", error: message });
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      void this.check(false).finally(() => this.schedule(CHECK_INTERVAL_MS));
    }, ms);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    // #7vyqfcpn: every change gets a newer stamp, so the window can tell a late answer from a fresh push.
    this.seq += 1;
    this.deps.onChange?.(this.getState());
  }
}

/** Where Windows' `Gumply.exe` lives (the install folder for the process check). */
export function installDirOf(execPath: string): string {
  return dirname(execPath) + sep;
}
