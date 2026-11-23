import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateSettings } from "../src/settings.js";
import {
  CHECK_INTERVAL_MS,
  effectiveMode,
  FIRST_CHECK_DELAY_MS,
  installKind,
  offeredModes,
  othersFromInstallDir,
  releaseUrl,
  replaceAppImage,
  UpdateController,
  type ProcessInfo,
  type UpdaterLike,
} from "../src/updates.js";

/** spec/auto-update (D42), #a7qepp99. */

describe("installKind and the mode in effect", () => {
  const base = { packaged: true, hasUpdateConfig: true };
  it("tells the formats apart", () => {
    expect(installKind({ ...base, platform: "win32" })).toBe("nsis");
    expect(installKind({ ...base, platform: "darwin" })).toBe("mac");
    expect(installKind({ ...base, platform: "linux", appImage: "/home/u/Apps/Gumply-0.9.0-x86_64.AppImage" })).toBe("appimage");
    expect(installKind({ ...base, platform: "linux", packageType: "deb\n" })).toBe("deb");
    expect(installKind({ ...base, platform: "linux" })).toBe("none");
  });

  it("never updates a development build or one without update config", () => {
    expect(installKind({ platform: "win32", packaged: false, hasUpdateConfig: true })).toBe("none");
    expect(installKind({ platform: "win32", packaged: true, hasUpdateConfig: false })).toBe("none");
  });

  it("defaults to automatic where Gumply can install, else to a notice; never automatic on .deb/macOS", () => {
    expect(effectiveMode("nsis")).toBe("auto");
    expect(effectiveMode("appimage")).toBe("auto");
    expect(effectiveMode("deb")).toBe("notify");
    expect(effectiveMode("mac")).toBe("notify");
    expect(effectiveMode("mac", "auto")).toBe("notify");
    expect(effectiveMode("nsis", "off")).toBe("off");
    expect(effectiveMode("none", "auto")).toBe("off");
  });

  it("offers automatic only where Gumply can install", () => {
    expect(offeredModes("nsis")).toEqual(["auto", "notify", "off"]);
    expect(offeredModes("appimage")).toEqual(["auto", "notify", "off"]);
    expect(offeredModes("deb")).toEqual(["notify", "off"]);
    expect(offeredModes("mac")).toEqual(["notify", "off"]);
  });

  it("links the release page", () => {
    expect(releaseUrl("0.9.1")).toBe("https://github.com/arslanarm/gumply/releases/tag/v0.9.1");
  });
});

describe("replaceAppImage: the same path, atomically", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gumply-appimage-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts the new image at exactly the old path, executable, with nothing left beside it", () => {
    const apps = join(dir, "Apps");
    mkdirSync(apps);
    const target = join(apps, "Gumply-0.9.0-x86_64.AppImage");
    writeFileSync(target, "old", { mode: 0o755 });
    const downloaded = join(dir, "cache-Gumply-0.9.1-x86_64.AppImage");
    writeFileSync(downloaded, "new", { mode: 0o644 });

    expect(replaceAppImage(downloaded, target)).toBe("installed");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    // Not renamed to the new version's name; no temp file left behind.
    expect(readdirSync(apps)).toEqual(["Gumply-0.9.0-x86_64.AppImage"]);
  });

  it("a folder it can't write to: read-only, and the old image is untouched", () => {
    const target = join(dir, "Gumply.AppImage");
    writeFileSync(target, "old", { mode: 0o755 });
    const downloaded = join(tmpdir(), `gumply-dl-${process.pid}`);
    writeFileSync(downloaded, "new");
    chmodSync(dir, 0o555);
    try {
      expect(replaceAppImage(downloaded, target)).toBe("read-only");
      expect(readFileSync(target, "utf8")).toBe("old");
    } finally {
      rmSync(downloaded, { force: true });
    }
  });
});

describe("othersFromInstallDir (Windows)", () => {
  const dir = "C:\\Users\\me\\AppData\\Local\\Programs\\Gumply";
  const exe = `${dir}\\Gumply.exe`;
  const list: ProcessInfo[] = [
    { pid: 100, parentPid: 1, path: exe }, // this app
    { pid: 101, parentPid: 100, path: exe }, // its GPU helper
    { pid: 102, parentPid: 101, path: exe }, // a grandchild
    { pid: 200, parentPid: 50, path: "c:\\users\\ME\\appdata\\local\\programs\\gumply\\Gumply.exe" }, // Claude's --mcp
    { pid: 300, parentPid: 1, path: "C:\\Users\\me\\AppData\\Local\\Programs\\GumplyOther\\x.exe" },
    { pid: 400, parentPid: 1, path: null },
  ];

  it("finds an AI app's Gumply.exe --mcp, not this app or its children, case-insensitively", () => {
    expect(othersFromInstallDir(list, dir, 100).map((p) => p.pid)).toEqual([200]);
    expect(othersFromInstallDir(list.slice(0, 3), `${dir}\\`, 100)).toEqual([]);
  });
});

/** A stand-in for electron-updater's AppUpdater. */
function fakeUpdater() {
  const listeners = new Map<string, (arg: unknown) => void>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    requestHeaders: null as Record<string, string> | null,
    checkForUpdates: vi.fn(async () => undefined as unknown),
    downloadUpdate: vi.fn(async () => undefined as unknown),
    install: vi.fn((_silent?: boolean, _run?: boolean) => true),
    on: (event: string, listener: (arg: never) => void) => listeners.set(event, listener as (arg: unknown) => void),
    emit: (event: string, arg?: unknown) => listeners.get(event)?.(arg),
  };
  return updater as typeof updater & UpdaterLike;
}

function controller(kind: "nsis" | "appimage" | "deb" | "mac", saved: UpdateSettings | undefined = undefined, extra: Partial<ConstructorParameters<typeof UpdateController>[0]> = {}) {
  let store = saved;
  const updater = fakeUpdater();
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const instance = new UpdateController({
    kind,
    currentVersion: "0.9.0",
    updater,
    load: () => store,
    save: (next) => {
      store = next;
    },
    now: () => new Date("2026-11-23T10:00:00Z"),
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    ...extra,
  });
  return { instance, updater, timers, store: () => store };
}

describe("UpdateController policy", () => {
  it("sets electron-updater up: no auto install on quit, no prereleases or downgrades, our User-Agent only", () => {
    const { updater } = controller("nsis");
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.requestHeaders).toEqual({ "User-Agent": "Gumply" });
  });

  it("checks 30 s after start, then daily", async () => {
    const { instance, updater, timers } = controller("nsis");
    instance.start();
    expect(timers.at(-1)!.ms).toBe(FIRST_CHECK_DELAY_MS);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    timers.at(-1)!.callback();
    await vi.waitFor(() => expect(timers.at(-1)!.ms).toBe(CHECK_INTERVAL_MS));
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("off: no automatic request at all; Check now still works", async () => {
    const { instance, updater, timers } = controller("nsis", { mode: "off" });
    instance.start();
    timers.at(-1)!.callback();
    await Promise.resolve();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await instance.check(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("automatic: a newer version downloads in the background and becomes ready; lastChecked is saved", async () => {
    const { instance, updater, store } = controller("appimage", undefined, { appImagePath: "/apps/Gumply.AppImage" });
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.9.1" });
      return undefined;
    });
    await instance.check(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(instance.getState().status).toBe("downloading");
    updater.emit("update-downloaded", { version: "0.9.1", downloadedFile: "/cache/Gumply-0.9.1-x86_64.AppImage" });
    expect(instance.getState()).toMatchObject({ status: "ready", version: "0.9.1", releaseUrl: releaseUrl("0.9.1") });
    expect(store()?.lastChecked).toBe("2026-11-23T10:00:00.000Z");
  });

  it("notify (and .deb/macOS): tells, never downloads", async () => {
    for (const [kind, saved] of [["nsis", { mode: "notify" }], ["deb", undefined], ["mac", undefined]] as const) {
      const { instance, updater } = controller(kind, saved);
      updater.checkForUpdates.mockImplementation(async () => {
        updater.emit("update-available", { version: "0.9.1" });
        return undefined;
      });
      await instance.check(true);
      expect(instance.getState().status).toBe("available");
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      expect(instance.installOnQuit()).toBe("nothing");
    }
  });

  it("an offline check is an error state, nothing else", async () => {
    const { instance, updater } = controller("nsis");
    updater.checkForUpdates.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
    await instance.check(true);
    expect(instance.getState()).toMatchObject({ status: "error", error: "net::ERR_INTERNET_DISCONNECTED" });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
});

describe("UpdateController at quit", () => {
  async function ready(kind: "nsis" | "appimage", extra: Partial<ConstructorParameters<typeof UpdateController>[0]>) {
    const made = controller(kind, undefined, extra);
    made.updater.checkForUpdates.mockImplementation(async () => {
      made.updater.emit("update-available", { version: "0.9.1" });
      return undefined;
    });
    await made.instance.check(true);
    made.updater.emit("update-downloaded", { version: "0.9.1", downloadedFile: "/cache/new.AppImage" });
    return made;
  }

  it("nothing downloaded: nothing installed", () => {
    expect(controller("nsis").instance.installOnQuit()).toBe("nothing");
  });

  it("AppImage: our own replacement onto $APPIMAGE, never electron-updater's install", async () => {
    const replace = vi.fn(() => "installed" as const);
    const { instance, updater } = await ready("appimage", { appImagePath: "/home/u/Apps/Gumply-0.9.0-x86_64.AppImage", replace });
    expect(instance.installOnQuit()).toBe("installed");
    expect(replace).toHaveBeenCalledWith("/cache/new.AppImage", "/home/u/Apps/Gumply-0.9.0-x86_64.AppImage");
    expect(updater.install).not.toHaveBeenCalled();
  });

  it("AppImage in a read-only folder: not installed, said so", async () => {
    const { instance } = await ready("appimage", { appImagePath: "/opt/Gumply.AppImage", replace: () => "read-only" });
    expect(instance.installOnQuit()).toBe("read-only");
    expect(instance.getState().status).toBe("read-only");
  });

  const dir = "C:\\Programs\\Gumply";
  const self: ProcessInfo = { pid: 10, parentPid: 1, path: `${dir}\\Gumply.exe` };

  it("Windows with an AI app's Gumply.exe --mcp running: pending, nothing started, retried at the next quit", async () => {
    let processes: ProcessInfo[] = [self, { pid: 20, parentPid: 5, path: `${dir}\\Gumply.exe` }];
    const { instance, updater } = await ready("nsis", { installDir: dir, selfPid: 10, listProcesses: () => processes });
    expect(instance.installOnQuit()).toBe("pending-running");
    expect(instance.getState().status).toBe("pending-running");
    expect(updater.install).not.toHaveBeenCalled();
    processes = [self];
    expect(instance.installOnQuit(true)).toBe("installed");
    expect(updater.install).toHaveBeenCalledWith(true, true);
  });

  it("Windows when the process list can't be read: pending (never risk killing an AI app's server)", async () => {
    const { instance, updater } = await ready("nsis", { installDir: dir, selfPid: 10, listProcesses: () => null });
    expect(instance.installOnQuit()).toBe("pending-running");
    expect(updater.install).not.toHaveBeenCalled();
  });

  it("Windows, nothing else running: the silent installer starts", async () => {
    const { instance, updater } = await ready("nsis", { installDir: dir, selfPid: 10, listProcesses: () => [self] });
    expect(instance.installOnQuit()).toBe("installed");
    expect(updater.install).toHaveBeenCalledWith(true, false);
  });

  it("a ready or pending update isn't checked for again", async () => {
    const { instance, updater } = await ready("nsis", { installDir: dir, selfPid: 10, listProcesses: () => null });
    updater.checkForUpdates.mockClear();
    await instance.check(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("UpdateController with update signing (option B)", () => {
  type Verify = NonNullable<ConstructorParameters<typeof UpdateController>[0]["verify"]>;
  async function downloaded(verify: Verify, extra: Partial<ConstructorParameters<typeof UpdateController>[0]> = {}) {
    const replace = vi.fn(() => "installed" as const);
    const log = vi.fn();
    const made = controller("appimage", undefined, { appImagePath: "/home/u/Apps/Gumply.AppImage", replace, verify, log, ...extra });
    made.updater.checkForUpdates.mockImplementation(async () => {
      made.updater.emit("update-available", { version: "0.9.1" });
      return undefined;
    });
    await made.instance.check(true);
    made.updater.emit("update-downloaded", { version: "0.9.1", downloadedFile: "/cache/Gumply-0.9.1-x86_64.AppImage" });
    await vi.waitFor(() => expect(made.instance.getState().status).not.toBe("downloading"));
    return { ...made, replace, log };
  }

  it("a download that doesn't verify never becomes ready, installs nothing, and says why", async () => {
    const { instance, replace, log } = await downloaded(async () => ({ ok: false, reason: "bad signature" }));
    expect(instance.getState()).toMatchObject({ status: "verify-failed", version: "0.9.1", releaseUrl: releaseUrl("0.9.1"), error: "bad signature" });
    expect(instance.installOnQuit()).toBe("nothing");
    expect(replace).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not verified: bad signature"));
  });

  it("a verify that throws counts as a failure", async () => {
    const { instance } = await downloaded(async () => {
      throw new Error("offline");
    });
    expect(instance.getState()).toMatchObject({ status: "verify-failed", error: "offline" });
  });

  it("the same version isn't downloaded again after a failure; a newer one is", async () => {
    const { instance, updater } = await downloaded(async () => ({ ok: false, reason: "bad signature" }));
    updater.downloadUpdate.mockClear();
    await instance.check(true);
    expect(instance.getState().status).toBe("verify-failed");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.9.2" });
      return undefined;
    });
    await instance.check(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("a verified download is ready and installs after the re-hash matches", async () => {
    const hashFileSync = vi.fn(() => "a".repeat(64));
    const { instance, replace } = await downloaded(async () => ({ ok: true, sha256: "a".repeat(64) }), { hashFileSync });
    expect(instance.getState().status).toBe("ready");
    expect(instance.installOnQuit()).toBe("installed");
    expect(hashFileSync).toHaveBeenCalledWith("/cache/Gumply-0.9.1-x86_64.AppImage");
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("a file changed after it verified: the re-hash fails at quit, nothing installed", async () => {
    const { instance, replace } = await downloaded(async () => ({ ok: true, sha256: "a".repeat(64) }), { hashFileSync: () => "b".repeat(64) });
    expect(instance.installOnQuit()).toBe("verify-failed");
    expect(instance.getState()).toMatchObject({ status: "verify-failed", error: expect.stringMatching(/changed after/) });
    expect(replace).not.toHaveBeenCalled();
  });

  it("Windows: the installer is re-hashed before it starts", async () => {
    const dir = "C:\\Programs\\Gumply";
    const self: ProcessInfo = { pid: 10, parentPid: 1, path: `${dir}\\Gumply.exe` };
    const made = controller("nsis", undefined, {
      installDir: dir,
      selfPid: 10,
      listProcesses: () => [self],
      verify: async () => ({ ok: true, sha256: "a".repeat(64) }),
      hashFileSync: () => "c".repeat(64),
    });
    made.updater.checkForUpdates.mockImplementation(async () => {
      made.updater.emit("update-available", { version: "0.9.1" });
      return undefined;
    });
    await made.instance.check(true);
    made.updater.emit("update-downloaded", { version: "0.9.1", downloadedFile: "C:\\cache\\Gumply-Setup-0.9.1.exe" });
    await vi.waitFor(() => expect(made.instance.getState().status).toBe("ready"));
    expect(made.instance.installOnQuit()).toBe("verify-failed");
    expect(made.updater.install).not.toHaveBeenCalled();
  });

  it("without signing (no verify): ready at once, no hashing (today's behaviour)", async () => {
    const hashFileSync = vi.fn(() => "x");
    const made = controller("appimage", undefined, { appImagePath: "/a.AppImage", replace: () => "installed", hashFileSync });
    made.updater.emit("update-downloaded", { version: "0.9.1", downloadedFile: "/cache/x.AppImage" });
    expect(made.instance.getState().status).toBe("ready");
    expect(made.instance.installOnQuit()).toBe("installed");
    expect(hashFileSync).not.toHaveBeenCalled();
  });
});
