import { describe, expect, it, vi } from "vitest";
import { classifyLoadFailure, lazyPart } from "../src/lazy-parts";

const Real = () => null;

describe("lazyPart (#evh35bn7)", () => {
  it("loads the code once, however often it is preloaded", async () => {
    const load = vi.fn(async () => Real);
    const part = lazyPart(load);
    await Promise.all([part.preload(), part.preload()]);
    await part.preload();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("renders a suspending stand-in until loaded, then the component itself", async () => {
    const part = lazyPart(async () => Real);
    const before = part.current();
    expect(before.ready).toBe(false);
    expect(before.Component).not.toBe(Real);
    await part.preload();
    expect(part.current()).toEqual({ Component: Real, ready: true });
  });

  it("retries after a failed load instead of caching the failure", async () => {
    const load = vi
      .fn<() => Promise<typeof Real>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Real);
    const part = lazyPart(load);
    await expect(part.preload()).rejects.toThrow("offline");
    expect(part.current().ready).toBe(false);
    await part.preload();
    expect(load).toHaveBeenCalledTimes(2);
    expect(part.current().ready).toBe(true);
  });
});

describe("classifyLoadFailure (#fzfrkpta)", () => {
  const chunk = "http://localhost:5173/assets/GraphView-Ab12_c.js";
  const chromeError = new TypeError(`Failed to fetch dynamically imported module: ${chunk}`);
  const firefoxError = new TypeError(`error loading dynamically imported module: ${chunk}`);
  const respond = (status: number) => vi.fn(async () => new Response(null, { status }));

  it("calls a chunk that is gone (404) an update", async () => {
    const fetchImpl = respond(404);
    expect(await classifyLoadFailure(chromeError, fetchImpl)).toBe("updated");
    expect(fetchImpl).toHaveBeenCalledWith(chunk, { method: "HEAD", cache: "no-store" });
    expect(await classifyLoadFailure(firefoxError, respond(404))).toBe("updated");
  });

  it("treats a reachable chunk or a network error as worth trying again", async () => {
    expect(await classifyLoadFailure(chromeError, respond(200))).toBe("unreachable");
    expect(await classifyLoadFailure(chromeError, respond(502))).toBe("unreachable");
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await classifyLoadFailure(chromeError, offline)).toBe("unreachable");
  });

  it("does not probe when the error names no chunk", async () => {
    const fetchImpl = respond(404);
    expect(await classifyLoadFailure(new TypeError("Importing a module script failed."), fetchImpl)).toBe(
      "unreachable",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
