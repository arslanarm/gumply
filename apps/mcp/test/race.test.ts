/**
 * Racing the app's editor (spec/mcp §1, D35), with a second `VaultStore`
 * standing in for the app on the same vault. MCP never waits on the app, and
 * the user never loses text.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultStore } from "../../server/src/vault-store.js";
import { VaultError } from "../../server/src/errors.js";
import { pageKey, readIndex } from "../src/history.js";
import { codeOf, connect, ERAS, makeVault, writeSettings, type Connection } from "./harness.js";

describe.each(ERAS)("racing the app (%s client)", (era) => {
  let vault: ReturnType<typeof makeVault>;
  let mcp: Connection;
  let app: VaultStore;
  const disk = () => readFileSync(join(vault.dir, "Projects/Plan.md"), "utf8");

  beforeEach(async () => {
    vault = makeVault();
    writeSettings(vault.dir, { access: "edit" });
    app = new VaultStore(vault.dir);
    await app.init();
    mcp = await connect(vault.dir, era);
  }, 30_000);

  afterEach(async () => {
    await mcp.close();
    app.stopWatching();
    vault.cleanup();
  });

  it("case 1: the user saved after the model's read → CONFLICT, the user's text on disk", async () => {
    const modelRead = (await mcp.call("read", { id: "Projects/Plan" })).structuredContent!.updated as string;
    const loaded = app.get("Projects/Plan");
    const saved = await app.update("Projects/Plan", { content: "# Plan\n\nThe user's edit.\n", expectedUpdated: loaded.updated, writer: "app-editor" });

    const started = Date.now();
    const result = await mcp.call("update_page", { id: "Projects/Plan", expectedUpdated: modelRead, content: "The model's version.\n" });
    expect(Date.now() - started).toBeLessThan(5000); // never waits on the app
    expect(codeOf(result)).toBe("CONFLICT");
    expect((result.structuredContent!.error as { currentUpdated: string }).currentUpdated).toBe(saved.updated);
    expect(disk()).toContain("The user's edit.");
    expect(disk()).not.toContain("The model's version.");
    // Reading again shows the model the user's text.
    expect((await mcp.call("read", { id: "Projects/Plan" })).structuredContent!.content).toContain("The user's edit.");
  });

  it("case 2: unsaved typing, then the MCP write lands → the app's save is a 409; Keep mine keeps both versions", async () => {
    const loaded = app.get("Projects/Plan");
    const original = disk();
    const modelRead = (await mcp.call("read", { id: "Projects/Plan" })).structuredContent!.updated as string;
    expect(modelRead).toBe(loaded.updated);
    const result = await mcp.call("update_page", { id: "Projects/Plan", expectedUpdated: modelRead, content: "# Plan\n\nThe model's version.\n" });
    expect(result.isError).toBeFalsy();
    expect(disk()).toContain("The model's version.");

    // The app's autosave with the version it loaded: refused, nothing lost.
    const typed = { content: "# Plan\n\nThe user's unsaved typing.\n", expectedUpdated: loaded.updated, writer: "app-editor" };
    await expect(app.update("Projects/Plan", typed)).rejects.toSatisfy((error: unknown) => error instanceof VaultError && error.status === 409);
    expect(disk()).toContain("The model's version.");

    // Keep mine: the user's text wins; the MCP version goes to .gumply/conflicts/,
    // and the version MCP replaced is already in .gumply/history/.
    await app.update("Projects/Plan", { ...typed, force: true });
    expect(disk()).toContain("The user's unsaved typing.");
    const conflicts = readdirSync(join(vault.dir, ".gumply/conflicts"), { recursive: true }).map(String);
    const backups = conflicts.map((name) => {
      try {
        return readFileSync(join(vault.dir, ".gumply/conflicts", name), "utf8");
      } catch {
        return "";
      }
    });
    expect(backups.some((text) => text.includes("The model's version."))).toBe(true);
    const [entry] = await readIndex(join(vault.dir, ".gumply/history", pageKey("Projects/Plan")));
    expect(readFileSync(join(vault.dir, ".gumply/history", pageKey("Projects/Plan"), entry!.file), "utf8")).toBe(original);
  });

  it("append_to_page after the user's save: sees it and adds after it", async () => {
    const loaded = app.get("Projects/Plan");
    await app.update("Projects/Plan", { content: `${loaded.content}\nUser line.\n`, expectedUpdated: loaded.updated, writer: "app-editor" });
    const result = await mcp.call("append_to_page", { id: "Projects/Plan", markdown: "Model line." });
    expect(result.isError).toBeFalsy();
    expect(disk()).toMatch(/User line\.\n\nModel line\.\n$/);
  });
});
