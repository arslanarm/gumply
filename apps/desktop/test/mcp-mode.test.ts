import { describe, expect, it } from "vitest";
import { exitAfterCleanup, hasFusermount, mcpLaunchCommand, mcpModeArgs, userNamespacesWork } from "../src/mcp-mode";

describe("desktop MCP mode arguments (A3)", () => {
  it("is off without --mcp", () => {
    expect(mcpModeArgs(["/opt/Gumply/gumply"])).toBeNull();
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--vault", "/v"])).toBeNull();
  });

  it("reads --vault (both forms) and --read-only, ignoring Electron's own flags", () => {
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--mcp", "--vault", "/home/you/Notes"])).toEqual({ vault: "/home/you/Notes", readOnly: false });
    expect(mcpModeArgs(["electron", "/app", "--no-sandbox", "--mcp", "--vault=C:\\Notes", "--read-only", "--enable-logging"])).toEqual({
      vault: "C:\\Notes",
      readOnly: true,
    });
    expect(mcpModeArgs(["gumply", "--mcp"])).toEqual({ vault: null, readOnly: false });
    expect(mcpModeArgs(["gumply", "--mcp", "--vault"])).toEqual({ vault: null, readOnly: false });
  });

  it("A4: `gumply mcp --vault …` (the npm form, /usr/bin/gumply from a .deb) is MCP mode too, never a window", () => {
    expect(mcpModeArgs(["/opt/Gumply/gumply", "mcp", "--vault", "/home/you/Notes"])).toEqual({ vault: "/home/you/Notes", readOnly: false });
    expect(mcpModeArgs(["/repo/electron", "/repo/apps/desktop", "mcp", "--vault=/v", "--read-only"], 2)).toEqual({ vault: "/v", readOnly: true });
    // Only as the first user argument: a vault, folder or file named "mcp" anywhere else opens the app.
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--vault", "mcp"])).toBeNull();
    expect(mcpModeArgs(["/opt/Gumply/gumply", "/home/you/Notes", "mcp"])).toBeNull();
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--no-sandbox", "mcp"])).toBeNull();
    expect(mcpModeArgs(["/opt/Gumply/gumply", "/home/you/mcp"])).toBeNull();
    expect(mcpModeArgs(["/opt/Gumply/gumply", "./mcp"])).toBeNull();
    // Development: the app folder comes first; "mcp" in the app folder's place is not the subcommand.
    expect(mcpModeArgs(["/repo/electron", "mcp", "--vault", "/v"], 2)).toBeNull();
    expect(mcpModeArgs(["/repo/electron", "/repo/apps/desktop", "--inspect", "mcp"], 2)).toBeNull();
  });
});

/** A4: the snippet's command per packaging. AI apps have no login shell or user PATH: always absolute, always there. */
describe("mcpLaunchCommand", () => {
  const linux = { platform: "linux", packaged: true };
  it("AppImage: the .AppImage file itself, never the temporary mount", () => {
    expect(
      mcpLaunchCommand({ ...linux, execPath: "/tmp/.mount_GumplyAb12/gumply", appPath: "/tmp/.mount_GumplyAb12/resources/app.asar", appImage: "/home/you/Apps/Gumply-0.8.0-x86_64.AppImage" }),
    ).toEqual({ command: "/home/you/Apps/Gumply-0.8.0-x86_64.AppImage", args: ["--mcp", "--ozone-platform=headless"], hint: "appimage" });
  });

  it(".deb: the installed executable under /opt (not the /usr/bin symlink, which the npm bin shares a name with)", () => {
    // On Linux it never needs a display (an AI app may start it over SSH or headless).
    expect(mcpLaunchCommand({ ...linux, execPath: "/opt/Gumply/gumply", appPath: "/opt/Gumply/resources/app.asar" })).toEqual({
      command: "/opt/Gumply/gumply",
      args: ["--mcp", "--ozone-platform=headless"],
    });
    // A relative APPIMAGE (never set by the runtime) is ignored.
    expect(mcpLaunchCommand({ ...linux, execPath: "/opt/Gumply/gumply", appPath: "/x", appImage: "Gumply.AppImage" }).command).toBe("/opt/Gumply/gumply");
  });

  it("development: Electron with the app folder first", () => {
    expect(mcpLaunchCommand({ platform: "linux", packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo/apps/desktop" })).toEqual({
      command: "/repo/node_modules/electron/dist/electron",
      args: ["/repo/apps/desktop", "--mcp", "--ozone-platform=headless"],
    });
  });

  it("macOS: the app in Applications; run from the disk image or a translocated copy, a hint to move it first", () => {
    const mac = { platform: "darwin", packaged: true, appPath: "/x" };
    expect(mcpLaunchCommand({ ...mac, execPath: "/Applications/Gumply.app/Contents/MacOS/Gumply" })).toEqual({
      command: "/Applications/Gumply.app/Contents/MacOS/Gumply",
      args: ["--mcp"],
    });
    expect(mcpLaunchCommand({ ...mac, execPath: "/Users/me/Applications/Gumply.app/Contents/MacOS/Gumply" }).hint).toBeUndefined();
    expect(mcpLaunchCommand({ ...mac, execPath: "/Volumes/Gumply 0.8.0/Gumply.app/Contents/MacOS/Gumply" }).hint).toBe("macos-location");
    expect(mcpLaunchCommand({ ...mac, execPath: "/private/var/folders/x/AppTranslocation/1/d/Gumply.app/Contents/MacOS/Gumply" }).hint).toBe("macos-location");
  });

  it("Windows: the installed Gumply.exe", () => {
    expect(mcpLaunchCommand({ platform: "win32", packaged: true, execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Gumply\\Gumply.exe", appPath: "x" })).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Gumply\\Gumply.exe",
      args: ["--mcp"],
    });
  });
});

/** #4ckqijua: Ubuntu 23.10+ restricts unprivileged user namespaces (AppArmor); FUSE for the static AppImage runtime. */
describe("restricted user namespaces and FUSE (#4ckqijua)", () => {
  const dev = { platform: "linux", packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo/apps/desktop" };
  it("development without working user namespaces runs without the sandbox, as AppRun decides for the AppImage", () => {
    expect(mcpLaunchCommand({ ...dev, userNamespaces: false }).args).toEqual(["/repo/apps/desktop", "--mcp", "--ozone-platform=headless", "--no-sandbox"]);
    expect(mcpLaunchCommand({ ...dev, userNamespaces: true }).args).not.toContain("--no-sandbox");
    expect(mcpLaunchCommand(dev).args).not.toContain("--no-sandbox");
    // Not Linux: no such restriction.
    expect(mcpLaunchCommand({ ...dev, platform: "darwin", userNamespaces: false }).args).not.toContain("--no-sandbox");
  });

  it("packaged builds never get --no-sandbox from us: the .deb's AppArmor profile or the AppImage's AppRun decides", () => {
    const deb = mcpLaunchCommand({ platform: "linux", packaged: true, execPath: "/opt/Gumply/gumply", appPath: "/x", userNamespaces: false });
    expect(deb.args).toEqual(["--mcp", "--ozone-platform=headless"]);
    const appImage = mcpLaunchCommand({ platform: "linux", packaged: true, execPath: "/tmp/.mount_x/gumply", appPath: "/x", appImage: "/home/you/Gumply.AppImage", userNamespaces: false });
    expect(appImage.args).toEqual(["--mcp", "--ozone-platform=headless"]);
  });

  it("an AppImage on a system without fusermount says so in Settings → AI apps", () => {
    const base = { platform: "linux", packaged: true, execPath: "/tmp/.mount_x/gumply", appPath: "/x", appImage: "/home/you/Gumply.AppImage" };
    expect(mcpLaunchCommand({ ...base, fusermount: false }).warning).toBe("fuse");
    expect(mcpLaunchCommand({ ...base, fusermount: true }).warning).toBeUndefined();
    expect(mcpLaunchCommand({ platform: "linux", packaged: true, execPath: "/opt/Gumply/gumply", appPath: "/x", fusermount: false }).warning).toBeUndefined();
  });

  it("the probes: AppRun's user-namespace check, and fusermount from fuse3 or fuse 2", () => {
    const has = (paths: string[]) => (path: string) => paths.includes(path);
    const calls: string[][] = [];
    expect(userNamespacesWork(has(["/proc/self/ns/user"]), (command, args) => (calls.push([command, ...args]), 0))).toBe(true);
    // AppRun's exact probe: `unshare -Ur true` (a bare `unshare --user` passes even under Ubuntu's restriction).
    expect(calls).toEqual([["unshare", "-Ur", "true"]]);
    expect(userNamespacesWork(has(["/proc/self/ns/user"]), () => 1)).toBe(false); // Ubuntu 24.04's AppArmor restriction
    expect(userNamespacesWork(has([]), () => 0)).toBe(false); // no user namespaces in the kernel
    expect(userNamespacesWork(has(["/proc/self/ns/user"]), () => null)).toBe(false); // unshare missing or timed out
    expect(hasFusermount(has(["/usr/bin/fusermount3"]))).toBe(true);
    expect(hasFusermount(has(["/bin/fusermount"]))).toBe(true);
    expect(hasFusermount(has([]))).toBe(false);
  });
});

/** #429bvzwr: on Windows our own Chromium children still hold files in the throwaway profile when stdin closes. */
describe("exitAfterCleanup", () => {
  it("exits even when the cleanup throws (ENOTEMPTY on Windows)", () => {
    const exits: number[] = [];
    exitAfterCleanup(
      () => {
        throw Object.assign(new Error("ENOTEMPTY, Directory not empty"), { code: "ENOTEMPTY" });
      },
      (code) => exits.push(code),
      0,
    );
    expect(exits).toEqual([0]);
  });

  it("runs the cleanup before exiting", () => {
    const order: string[] = [];
    exitAfterCleanup(() => order.push("cleanup"), (code) => order.push(`exit ${code}`), 2);
    expect(order).toEqual(["cleanup", "exit 2"]);
  });
});

