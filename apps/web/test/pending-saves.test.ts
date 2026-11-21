import { afterEach, describe, expect, it, vi } from "vitest";
import { flushAllOnExit, flushAllSaves, hasUnsavedChanges, registerSaver, type PendingSaver } from "../src/lib/pending-saves";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function saver(overrides: Partial<PendingSaver> = {}): PendingSaver {
  const value: PendingSaver = {
    isDirty: () => false,
    hasFailed: () => false,
    flush: async () => {},
    flushOnExit: () => true,
    ...overrides,
  };
  cleanups.push(registerSaver(value));
  return value;
}

describe("pending saves (#3t6v62cb)", () => {
  it("flushes every open editor and reports whether all is saved", async () => {
    let dirty = true;
    const flush = vi.fn(async () => {
      dirty = false;
    });
    saver({ isDirty: () => dirty, flush });
    saver();
    expect(hasUnsavedChanges()).toBe(true);
    expect(await flushAllSaves()).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("gives up after the timeout and says not everything is saved", async () => {
    vi.useFakeTimers();
    saver({ isDirty: () => true, flush: () => new Promise(() => {}) });
    const result = flushAllSaves(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBe(false);
  });

  it("on unload: true only when every saver could send (and none has failed)", () => {
    const first = vi.fn(() => true);
    saver({ flushOnExit: first });
    expect(flushAllOnExit()).toBe(true);
    const unregister = registerSaver({ isDirty: () => true, hasFailed: () => false, flush: async () => {}, flushOnExit: () => false });
    expect(flushAllOnExit()).toBe(false);
    unregister();
    saver({ hasFailed: () => true });
    expect(flushAllOnExit()).toBe(false);
    expect(first).toHaveBeenCalledTimes(3);
  });
});
