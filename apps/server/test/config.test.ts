import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("loadConfig", () => {
  it("defaults to the repo-root vault and port 3001", () => {
    const config = loadConfig({});
    expect(config.vaultPath).toBe(resolve(REPO_ROOT, "vault"));
    expect(config.port).toBe(3001);
  });

  it("honours GUMPLY_VAULT and PORT", () => {
    const config = loadConfig({ GUMPLY_VAULT: "/tmp/notes", PORT: "4444" });
    expect(config.vaultPath).toBe("/tmp/notes");
    expect(config.port).toBe(4444);
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ PORT: "nope" })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: "0" })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/Invalid PORT/);
  });
});
