import { afterEach, describe, expect, it, vi } from "vitest";
import { api, takeUnreachableSeen } from "../src/api/client";

/**
 * #2xx3uae4: any request that couldn't reach the local server is remembered
 * until the poll asks, so what failed in an outage shorter than a poll (History
 * opened just then) still loads again once the server answers.
 */
const answer = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => {
  vi.unstubAllGlobals();
  takeUnreachableSeen();
});

describe("takeUnreachableSeen", () => {
  it("a failed fetch is seen once, then forgotten", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.history("Plan")).rejects.toThrow();
    expect(takeUnreachableSeen()).toBe(true);
    expect(takeUnreachableSeen()).toBe(false);
  });

  it("a version's text (its own fetch, not request()) is seen too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.historyText("Plan", "2026-11-23T10-00-00-000Z.md")).rejects.toThrow();
    expect(takeUnreachableSeen()).toBe(true);
    vi.stubGlobal("fetch", answer(503));
    await expect(api.historyText("Plan", "x.md")).rejects.toThrow();
    expect(takeUnreachableSeen()).toBe(true);
  });

  it("a 5xx (the dev proxy while the server is down) is seen", async () => {
    vi.stubGlobal("fetch", answer(502, { error: "down" }));
    await expect(api.listPages()).rejects.toThrow();
    expect(takeUnreachableSeen()).toBe(true);
  });

  it("a server that answers, even 404 or 409, is not", async () => {
    vi.stubGlobal("fetch", answer(404, { error: "Page not found" }));
    await expect(api.getPage("Nope")).rejects.toThrow();
    vi.stubGlobal("fetch", answer(200, []));
    await api.listPages();
    expect(takeUnreachableSeen()).toBe(false);
  });
});
