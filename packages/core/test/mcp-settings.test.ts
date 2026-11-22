import { describe, expect, it } from "vitest";
import { parseMcpAuditLog, parseMcpSettings, serializeMcpSettings } from "../src/mcp-settings.js";

describe("MCP settings (spec/mcp §2, A3)", () => {
  it("no file, an invalid one, or odd values mean enabled at read", () => {
    expect(parseMcpSettings(null)).toEqual({ enabled: true, access: "read" });
    expect(parseMcpSettings("not json")).toEqual({ enabled: true, access: "read" });
    expect(parseMcpSettings("[]")).toEqual({ enabled: true, access: "read" });
    expect(parseMcpSettings('{"access":"admin"}')).toEqual({ enabled: true, access: "read" });
    expect(parseMcpSettings('{"enabled":false,"access":"edit"}')).toEqual({ enabled: false, access: "edit" });
    expect(parseMcpSettings('{"enabled":"no","access":"append"}')).toEqual({ enabled: true, access: "append" });
  });

  it("a change keeps the file's other keys and the unchanged setting", () => {
    const text = serializeMcpSettings('{"access":"append","note":"mine","future":{"x":1}}', { enabled: false });
    expect(JSON.parse(text)).toEqual({ access: "append", note: "mine", future: { x: 1 }, enabled: false });
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(serializeMcpSettings(null, { access: "edit" }))).toEqual({ enabled: true, access: "edit" });
  });
});

describe("MCP audit log (spec/mcp §4)", () => {
  it("reads well-formed rows and skips the rest", () => {
    const log = [
      '{"at":"2026-11-22T10:00:00.000Z","tool":"create_page","id":"Inbox/Idea","before":null,"after":"v1","client":"claude-code"}',
      "",
      "garbage",
      '{"at":"2026-11-22T10:01:00.000Z","tool":"update_page"}',
      '{"at":"2026-11-22T10:02:00.000Z","tool":"trash_page","id":"Old","before":"v2","after":null}',
    ].join("\n");
    expect(parseMcpAuditLog(log)).toEqual([
      { at: "2026-11-22T10:00:00.000Z", tool: "create_page", id: "Inbox/Idea", before: null, after: "v1", client: "claude-code" },
      { at: "2026-11-22T10:02:00.000Z", tool: "trash_page", id: "Old", before: "v2", after: null, client: "" },
    ]);
  });
});
