import { describe, expect, it } from "vitest";
import { claudeCodeSnippet, claudeDesktopConfigPath, claudeDesktopSnippet, mcpServerName, shellQuote } from "../src/lib/mcp-snippets.js";

const desktop = { command: "/opt/Gumply/gumply", args: ["--mcp"] };

describe("Settings → MCP snippets (A3)", () => {
  it("names the server after the vault folder", () => {
    expect(mcpServerName("/home/me/Work Notes")).toBe("gumply-work-notes");
    expect(mcpServerName("C:\\Users\\Me\\Café vault\\")).toBe("gumply-cafe-vault");
    expect(mcpServerName("/home/me/Заметки")).toBe("gumply");
  });

  it("quotes shell words only when needed, safely", () => {
    expect(shellQuote("/opt/Gumply/gumply", "linux")).toBe("/opt/Gumply/gumply");
    expect(shellQuote("/home/me/My Notes", "linux")).toBe('"/home/me/My Notes"');
    expect(shellQuote('/tmp/a"b$c`d\\e', "darwin")).toBe('"/tmp/a\\"b\\$c\\`d\\\\e"');
    expect(shellQuote("C:\\Program Files\\Gumply\\Gumply.exe", "win32")).toBe('"C:\\Program Files\\Gumply\\Gumply.exe"');
  });

  it("Claude Code: claude mcp add, user scope, the command then the vault", () => {
    expect(claudeCodeSnippet(desktop, "/home/me/My Notes", "linux")).toBe(
      'claude mcp add --transport stdio --scope user gumply-my-notes -- /opt/Gumply/gumply --mcp --vault "/home/me/My Notes"',
    );
    expect(claudeCodeSnippet({ command: "gumply", args: ["mcp"] }, "/v", "linux")).toBe("claude mcp add --transport stdio --scope user gumply-v -- gumply mcp --vault /v");
  });

  it("Claude Desktop: valid JSON with escaped Windows paths, and the config file per OS", () => {
    const snippet = claudeDesktopSnippet({ command: "C:\\Gumply\\Gumply.exe", args: ["--mcp"] }, "C:\\Notes");
    expect(JSON.parse(snippet)).toEqual({ mcpServers: { "gumply-notes": { command: "C:\\Gumply\\Gumply.exe", args: ["--mcp", "--vault", "C:\\Notes"] } } });
    expect(snippet).toContain('"C:\\\\Notes"');
    expect(claudeDesktopConfigPath("darwin")).toContain("Library/Application Support/Claude");
    expect(claudeDesktopConfigPath("win32")).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
    expect(claudeDesktopConfigPath("linux")).toBe("~/.config/Claude/claude_desktop_config.json");
  });
});
