import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushAllOnExit,
  flushAllSaves,
  flushAllSavesReport,
  hasUnsavedChanges,
  registerSaver,
  type PendingSaver,
} from "../src/lib/pending-saves";

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

  it("a best-effort saver (UI preferences) is flushed but never unsaved work (#ms44vnit)", async () => {
    const flush = vi.fn(async () => {});
    // A preference written during the flush keeps it dirty.
    saver({ kind: "ui-state", bestEffort: true, isDirty: () => true, flush, flushOnExit: () => false });
    expect(hasUnsavedChanges()).toBe(false);
    expect(await flushAllSaves()).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushAllOnExit()).toBe(true);
  });

  it("reports which savers aren't saved, how long it took and whether it timed out (#ms44vnit)", async () => {
    vi.useFakeTimers();
    saver({ kind: "page", hasFailed: () => true });
    saver({ kind: "board", isDirty: () => true, flush: () => new Promise(() => {}) });
    saver({ kind: "ui-state", bestEffort: true, isDirty: () => true });
    const result = flushAllSavesReport(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await result;
    expect(report).toMatchObject({
      saved: false,
      timedOut: true,
      unsaved: [
        { kind: "page", dirty: false, failed: true },
        { kind: "board", dirty: true, failed: false },
      ],
    });
    expect(report.ms).toBeGreaterThanOrEqual(10_000);
  });

  it("a quick, complete flush reports saved and no timeout", async () => {
    saver({ kind: "page" });
    expect(await flushAllSavesReport(10_000)).toMatchObject({ saved: true, timedOut: false, unsaved: [] });
  });
});
