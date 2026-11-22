import { describe, expect, it } from "vitest";
import { mcpLaunchCommand, mcpModeArgs } from "../src/mcp-mode";

describe("desktop MCP mode arguments (A3)", () => {
  it("is off without --mcp", () => {
    expect(mcpModeArgs(["/opt/Gumply/gumply"])).toBeNull();
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--vault", "/v"])).toBeNull();
  });

  it("reads --vault (both forms) and --read-only, ignoring Electron's own flags", () => {
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--mcp", "--vault", "/home/me/Notes"])).toEqual({ vault: "/home/me/Notes", readOnly: false });
    expect(mcpModeArgs(["electron", "/app", "--no-sandbox", "--mcp", "--vault=C:\\Notes", "--read-only", "--enable-logging"])).toEqual({
      vault: "C:\\Notes",
      readOnly: true,
    });
    expect(mcpModeArgs(["gumply", "--mcp"])).toEqual({ vault: null, readOnly: false });
    expect(mcpModeArgs(["gumply", "--mcp", "--vault"])).toEqual({ vault: null, readOnly: false });
  });

  it("A4: `gumply mcp --vault …` (the npm form, /usr/bin/gumply from a .deb) is MCP mode too, never a window", () => {
    expect(mcpModeArgs(["/opt/Gumply/gumply", "mcp", "--vault", "/home/me/Notes"])).toEqual({ vault: "/home/me/Notes", readOnly: false });
    expect(mcpModeArgs(["/repo/electron", "/repo/apps/desktop", "mcp", "--vault=/v", "--read-only"])).toEqual({ vault: "/v", readOnly: true });
    // A vault folder or file named "mcp" opened normally is not MCP mode.
    expect(mcpModeArgs(["/opt/Gumply/gumply", "--vault", "mcp"])).toBeNull();
    expect(mcpModeArgs(["/repo/electron", "--inspect", "mcp"])).toBeNull();
  });
});

/** A4: the snippet's command per packaging. AI apps have no login shell or user PATH: always absolute, always there. */
describe("mcpLaunchCommand", () => {
  const linux = { platform: "linux", packaged: true };
  it("AppImage: the .AppImage file itself, never the temporary mount", () => {
    expect(
      mcpLaunchCommand({ ...linux, execPath: "/tmp/.mount_GumplyAb12/gumply", appPath: "/tmp/.mount_GumplyAb12/resources/app.asar", appImage: "/home/me/Apps/Gumply-0.8.0-x86_64.AppImage" }),
    ).toEqual({ command: "/home/me/Apps/Gumply-0.8.0-x86_64.AppImage", args: ["--mcp", "--ozone-platform=headless"], hint: "appimage" });
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
