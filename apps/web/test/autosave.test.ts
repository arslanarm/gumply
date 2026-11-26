import { afterEach, describe, expect, it, vi } from "vitest";
import { Autosave, type SaveState } from "../src/editor/autosave.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Autosave", () => {
  it("#z9hufufn: rebase moves the baseline only; a held write returning the server's text leaves the merged edit to save next", async () => {
    vi.useFakeTimers();
    let release: (value: string) => void = () => undefined;
    const save = vi.fn((value: string) => (value === "held" ? new Promise<string>((resolve) => (release = resolve)) : Promise.resolve(value)));
    const autosave = new Autosave({ save, delay: 600 });
    autosave.reset("old");
    expect(autosave.baseline()).toBe("old");
    autosave.schedule("held");
    await vi.advanceTimersByTimeAsync(600); // the held write is in flight
    // The rename's rewrite is taken in place: the server's text is the baseline, the merged typing pending.
    autosave.rebase("server");
    expect(autosave.baseline()).toBe("server");
    autosave.schedule("server + typing");
    release("server"); // the held write isn't sent: it reports the server's text as written
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenLastCalledWith("server + typing");
    expect(autosave.baseline()).toBe("server + typing");
    expect(autosave.isDirty()).toBe(false);
  });

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

describe("Autosave on the way out (#3t6v62cb)", () => {
  it("sends a pending edit at once with exitSave, and only says Saved when it is confirmed", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    let confirm: (() => void) | undefined;
    const exitSave = vi.fn(
      (_value: string, _afterInFlight: boolean) =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    const autosave = new Autosave({ save, exitSave, delay: 600 });

    autosave.schedule("typed just now");
    expect(autosave.flushOnExit()).toBe(true);
    expect(exitSave).toHaveBeenCalledWith("typed just now", false);
    // The debounce is cancelled: no second, normal write.
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    expect(autosave.isDirty()).toBe(true);
    expect(autosave.state).toBe("idle");

    confirm?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(autosave.isDirty()).toBe(false);
    expect(autosave.state).toBe("saved");
    // Called twice (beforeunload, then pagehide): sent once.
    expect(autosave.flushOnExit()).toBe(true);
    expect(exitSave).toHaveBeenCalledTimes(1);
  });

  it("has nothing to send when everything is saved", () => {
    const exitSave = vi.fn(() => Promise.resolve());
    const autosave = new Autosave({ save: async () => {}, exitSave });
    autosave.reset("on disk");
    expect(autosave.flushOnExit()).toBe(true);
    autosave.schedule("on disk");
    expect(autosave.flushOnExit()).toBe(true);
    expect(exitSave).not.toHaveBeenCalled();
  });

  it("resends a write still in flight (an unload may cancel it), marked as after it", async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => new Promise<void>(() => {}));
    const exitSave = vi.fn((_value: string, _afterInFlight: boolean) => Promise.resolve());
    const autosave = new Autosave({ save, exitSave, delay: 100 });
    autosave.schedule("in flight");
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledWith("in flight");
    expect(autosave.flushOnExit()).toBe(true);
    expect(exitSave).toHaveBeenCalledWith("in flight", true);

    autosave.schedule("newer");
    expect(autosave.flushOnExit()).toBe(true);
    expect(exitSave).toHaveBeenLastCalledWith("newer", true);
  });

  it("reports false when it can't send (too big, no exitSave, a conflict), so the page warns", async () => {
    vi.useFakeTimers();
    const tooBig = new Autosave({ save: async () => {}, exitSave: () => null });
    tooBig.schedule("x".repeat(10));
    expect(tooBig.flushOnExit()).toBe(false);
    expect(tooBig.isDirty()).toBe(true);

    const none = new Autosave({ save: async () => {} });
    none.schedule("edit");
    expect(none.flushOnExit()).toBe(false);

    const conflict = new Error("409");
    const exitSave = vi.fn(() => Promise.resolve());
    const conflicted = new Autosave({
      save: async () => {
        throw conflict;
      },
      exitSave,
      isConflict: (error) => error === conflict,
      delay: 10,
    });
    conflicted.schedule("mine");
    await vi.advanceTimersByTimeAsync(10);
    expect(conflicted.state).toBe("conflict");
    expect(conflicted.flushOnExit()).toBe(false);
    expect(exitSave).not.toHaveBeenCalled();
  });

  it("a failed exit write keeps the edit pending and shows the error", async () => {
    const autosave = new Autosave({ save: async () => {}, exitSave: () => Promise.reject(new Error("offline")) });
    autosave.schedule("keep me");
    expect(autosave.flushOnExit()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autosave.state).toBe("error");
    expect(autosave.hasFailed()).toBe(true);
    expect(autosave.isDirty()).toBe(true);
  });
  it("N10: a save that answers with the text written makes that the baseline: the editor taking it in place sends nothing more", async () => {
    vi.useFakeTimers();
    let autosave: Autosave;
    const save = vi.fn(async (value: string): Promise<void | string> => {
      if (value !== "See [[Hub]].") return;
      // The server kept the rename's link; the editor takes it in place while the save returns.
      autosave.schedule("See [[Hub renamed]].");
      return "See [[Hub renamed]].";
    });
    autosave = new Autosave({ save, delay: 100 });
    autosave.schedule("See [[Hub]].");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(autosave.isDirty()).toBe(false);

    // Typing after it saves as usual, from the new baseline.
    autosave.schedule("See [[Hub renamed]]. More.");
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenLastCalledWith("See [[Hub renamed]]. More.");
  });

  it("N10: typing that arrived while that save was out is still saved after it", async () => {
    vi.useFakeTimers();
    let autosave: Autosave;
    const save = vi.fn(async (value: string): Promise<void | string> => {
      if (value !== "See [[Hub]].") return;
      autosave.schedule("See [[Hub renamed]]. typed");
      return "See [[Hub renamed]].";
    });
    autosave = new Autosave({ save, delay: 100 });
    autosave.schedule("See [[Hub]].");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("See [[Hub renamed]]. typed");
  });
});
