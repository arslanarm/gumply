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

  it("reports saving then saved", async () => {
    vi.useFakeTimers();
    const states: SaveState[] = [];
    const autosave = new Autosave({
      save: async () => {},
      delay: 300,
      onState: (state) => states.push(state),
    });

    autosave.schedule("draft");
    expect(states).toEqual(["saving"]);

    await vi.advanceTimersByTimeAsync(300);
    expect(states).toEqual(["saving", "saved"]);
    expect(autosave.state).toBe("saved");
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
