import { describe, expect, it, vi } from "vitest";
import { lazyPart } from "../src/lazy-parts";

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
