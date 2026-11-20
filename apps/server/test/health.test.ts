import { readFileSync } from "node:fs";
import { CORE_VERSION } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { cleanupVaults, createTestServer } from "./helpers";

const repo = new URL("../../../", import.meta.url);
const packageVersion = (path: string) =>
  (JSON.parse(readFileSync(new URL(path, repo), "utf8")) as { version: string }).version;

afterEach(cleanupVaults);

describe("GET /api/health", () => {
  it("reports the app, version and vault path", async () => {
    const { app, dir } = await createTestServer();
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Gumply");
    expect(body.vaultPath).toBe(dir);
    expect(body.version).toBe(CORE_VERSION);
  });

  it("reports the version it was started with (the desktop app's own)", async () => {
    const { store, dir } = await createTestServer();
    const app = createApp({ vaultPath: dir, store, version: "0.5.0-rc.3" });
    const body = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    expect(body.version).toBe("0.5.0-rc.3");
  });

  it("one version everywhere: core and every package.json agree", () => {
    for (const path of [
      "package.json",
      "packages/core/package.json",
      "apps/server/package.json",
      "apps/web/package.json",
      "apps/desktop/package.json",
    ]) {
      expect(packageVersion(path), path).toBe(CORE_VERSION);
    }
  });

  it("returns JSON 404s", async () => {
    const { app } = await createTestServer();
    const response = await app.request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
