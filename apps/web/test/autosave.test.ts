import { afterEach, describe, expect, it, vi } from "vitest";
import { Autosave, type SaveState } from "../src/editor/autosave.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Autosave", () => {
  it("debounces rapid edits and writes only the latest snapshot", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const autosave = new Autosave({ save, delay: 600 });

    autosave.schedule("one");
    autosave.schedule("two");
    autosave.schedule("three");

    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("three");
  });

  it("goes from blank idle to saved without flashing Saving for a fast write", async () => {
    vi.useFakeTimers();
    const states: SaveState[] = [];
    const autosave = new Autosave({
      save: async () => {},
      delay: 300,
      onState: (state) => states.push(state),
    });

    autosave.schedule("draft");
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(299);
    expect(states).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(["saved"]);
    expect(autosave.state).toBe("saved");
  });

  it("shows Saving only after the write has been in flight for 500ms", async () => {
    vi.useFakeTimers();
    const states: SaveState[] = [];
    let resolveWrite: (() => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const autosave = new Autosave({
      save,
      delay: 300,
      onState: (state) => states.push(state),
    });

    autosave.schedule("slow");
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]);

    await vi.advanceTimersByTimeAsync(499);
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(["saving"]);

    resolveWrite?.();
    await autosave.flush();
    expect(states).toEqual(["saving", "saved"]);
  });

  it("flushes immediately and cancels the pending timer", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const autosave = new Autosave({ save, delay: 600 });

    autosave.schedule("urgent");
    await autosave.flush();
    expect(save).toHaveBeenCalledWith("urgent");

    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not write when the value matches the loaded baseline", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const autosave = new Autosave({ save, delay: 100 });

    autosave.reset("hello");
    autosave.schedule("hello");

    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    expect(autosave.state).toBe("idle");
  });

  it("keeps the pending value after a failure and retries on flush", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(_value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const autosave = new Autosave({ save, delay: 200 });

    autosave.schedule("important");
    await vi.advanceTimersByTimeAsync(200);
    expect(autosave.state).toBe("error");
    expect(save).toHaveBeenCalledTimes(1);

    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("important");
    expect(autosave.state).toBe("saved");
  });

  it("serialises a newer edit made while a write is in flight", async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const save = vi
      .fn<(_value: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const autosave = new Autosave({ save, delay: 100 });

    autosave.schedule("first");
    await vi.advanceTimersByTimeAsync(100);

    autosave.schedule("second");
    resolveFirst?.();
    await autosave.flush();

    expect(save.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
  });

  it("flushes pending work on dispose", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const autosave = new Autosave({ save, delay: 600 });

    autosave.schedule("left the page");
    autosave.dispose();
    await autosave.flush();

    expect(save).toHaveBeenCalledWith("left the page");
  });
});

describe("Autosave conflict", () => {
  it("stops auto-retrying on a conflict and resumes with retry()", async () => {
    vi.useFakeTimers();
    const conflict = new Error("changed on disk");
    const save = vi
      .fn<(_value: string) => Promise<void>>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue(undefined);
    const states: SaveState[] = [];
    const autosave = new Autosave({
      save,
      delay: 100,
      isConflict: (error) => error === conflict,
      onState: (state) => states.push(state),
    });

    autosave.schedule("mine");
    await vi.advanceTimersByTimeAsync(100);
    expect(autosave.state).toBe("conflict");
    expect(save).toHaveBeenCalledTimes(1);
    expect(autosave.isDirty()).toBe(true);

    // Further typing keeps the conflict state and does not overwrite.
    autosave.schedule("mine plus more");
    await vi.advanceTimersByTimeAsync(500);
    expect(autosave.state).toBe("conflict");
    expect(save).toHaveBeenCalledTimes(1);

    await autosave.retry();
    expect(save).toHaveBeenCalledTimes(2);
    expect(autosave.state).toBe("saved");
    expect(autosave.isDirty()).toBe(false);
    expect(states).toContain("conflict");
  });
});
