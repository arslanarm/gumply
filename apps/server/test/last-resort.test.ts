import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { logUnhandledRejections } from "../src/last-resort";

/** #35q6kt6e: a rejection nothing handled is logged, and the process keeps running. */
describe("the last-resort rejection logger", () => {
  it("logs the reason of an unhandled rejection (never silently)", () => {
    const target = new EventEmitter();
    const log = vi.fn();
    const uninstall = logUnhandledRejections(log, target);
    const reason = new Error("ENOENT: gone mid-scan");
    target.emit("unhandledRejection", reason, Promise.resolve());
    expect(log).toHaveBeenCalledWith("[gumply] unhandled rejection (kept running):", reason);
    uninstall();
    target.emit("unhandledRejection", new Error("after"), Promise.resolve());
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("installs once per process however often the server starts", () => {
    const target = new EventEmitter();
    const first = logUnhandledRejections(vi.fn(), target);
    const second = logUnhandledRejections(vi.fn(), target);
    expect(target.listenerCount("unhandledRejection")).toBe(1);
    second(); // A no-op: only the first install removes its handler.
    expect(target.listenerCount("unhandledRejection")).toBe(1);
    first();
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });

  it("on the real process, a handler is registered (so Node doesn't exit on one)", () => {
    const before = process.listenerCount("unhandledRejection");
    const uninstall = logUnhandledRejections(vi.fn());
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    uninstall();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
