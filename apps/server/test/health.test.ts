import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const app = createApp({ vaultPath: "/tmp/gumply-vault" });

describe("GET /api/health", () => {
  it("reports the app, version and vault path", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Gumply");
    expect(body.vaultPath).toBe("/tmp/gumply-vault");
    expect(typeof body.version).toBe("string");
  });

  it("returns JSON 404s", async () => {
    const response = await app.request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
