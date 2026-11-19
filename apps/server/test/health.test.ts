import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

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
    expect(typeof body.version).toBe("string");
  });

  it("returns JSON 404s", async () => {
    const { app } = await createTestServer();
    const response = await app.request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
