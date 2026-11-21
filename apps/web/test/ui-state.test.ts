import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreUiState } from "../src/lib/ui-state";

class MemoryStorage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

/** A fresh class per test, so patching its prototype never leaks. */
function storage(entries: Record<string, string> = {}): Storage {
  const Fresh = class extends MemoryStorage {};
  const instance = new Fresh() as unknown as Storage;
  for (const [key, value] of Object.entries(entries)) instance.setItem(key, value);
  return instance;
}

function fakeFetch(state: Record<string, string> | null) {
  const calls: Array<{ method: string; body?: unknown; keepalive?: boolean }> = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, keepalive: init?.keepalive });
    if (state === null) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify(state), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("desktop UI preferences mirror (#c7fzzxk8)", () => {
  it("the browser app (no route): nothing changes, nothing is mirrored", async () => {
    vi.useFakeTimers();
    const local = storage({ "gumply:theme": "light" });
    const { impl, calls } = fakeFetch(null);
    expect(await restoreUiState(local, impl)).toBe(false);
    local.setItem("gumply:theme", "dark");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(local.getItem("gumply:theme")).toBe("dark");
  });

  it("restores the saved entries before render; the saved state wins", async () => {
    const local = storage({ "gumply:sidebar": "open", "gumply:stale": "x", unrelated: "kept" });
    const { impl } = fakeFetch({ "gumply:theme": "dark", "gumply:sidebar": "closed" });
    expect(await restoreUiState(local, impl)).toBe(true);
    expect(local.getItem("gumply:theme")).toBe("dark");
    expect(local.getItem("gumply:sidebar")).toBe("closed");
    expect(local.getItem("gumply:stale")).toBeNull();
    expect(local.getItem("unrelated")).toBe("kept");
  });

  it("mirrors later gumply:* writes and removals back, debounced into one PUT", async () => {
    vi.useFakeTimers();
    const local = storage();
    const { impl, calls } = fakeFetch({});
    await restoreUiState(local, impl);
    local.setItem("gumply:theme", "dark");
    local.setItem("gumply:theme", "light");
    local.setItem("gumply:board-view:Trip.canvas", '{"x":5}');
    local.removeItem("gumply:sidebar");
    local.setItem("not-ours", "x");
    await vi.advanceTimersByTimeAsync(299);
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // Once sent and answered, nothing is left pending (quit isn't held up).
    const { hasUnsavedChanges } = await import("../src/lib/pending-saves");
    await vi.advanceTimersByTimeAsync(0);
    expect(hasUnsavedChanges()).toBe(false);
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toEqual([
      {
        method: "PUT",
        body: { set: { "gumply:theme": "light", "gumply:board-view:Trip.canvas": '{"x":5}' }, remove: ["gumply:sidebar"] },
        keepalive: undefined,
      },
    ]);
  });

  it("flushes at once when the app quits or reloads (__gumplyFlush / pagehide)", async () => {
    vi.useFakeTimers();
    const local = storage();
    const { impl, calls } = fakeFetch({});
    await restoreUiState(local, impl);
    local.setItem("gumply:theme", "dark");
    const { flushAllOnExit } = await import("../src/lib/pending-saves");
    expect(flushAllOnExit()).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", keepalive: true, body: { set: { "gumply:theme": "dark" } } });
  });
});
