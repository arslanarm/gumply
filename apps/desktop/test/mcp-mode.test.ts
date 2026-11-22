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

  it("the command Settings → MCP shows: the executable, plus the app folder in development", () => {
    expect(mcpLaunchCommand("/opt/Gumply/gumply", true, "/opt/Gumply/resources/app.asar")).toEqual({ command: "/opt/Gumply/gumply", args: ["--mcp"] });
    expect(mcpLaunchCommand("/repo/node_modules/electron/dist/electron", false, "/repo/apps/desktop")).toEqual({
      command: "/repo/node_modules/electron/dist/electron",
      args: ["/repo/apps/desktop", "--mcp"],
    });
  });
});
