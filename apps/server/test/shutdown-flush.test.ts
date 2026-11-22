import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushWithin, HISTORY_FLUSH_TIMEOUT_MS, startGumplyServer } from "../src/start";
import { VaultStore } from "../src/vault-store";

/** #a7qepp99: shutdown never waits on version history past the cap. */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shutdown history flush is capped", () => {
  it("the cap is 3 s", () => {
    expect(HISTORY_FLUSH_TIMEOUT_MS).toBe(3_000);
  });

  it("a stuck flush gives up at the cap and says so on stderr", async () => {
    const warn = vi.fn();
    const started = Date.now();
    await flushWithin(() => new Promise<void>(() => undefined), 50, warn);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("still running after 50 ms"));
  });

  it("a flush that finishes (or fails) in time is waited for, silently", async () => {
    const warn = vi.fn();
    let finished = false;
    await flushWithin(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    }, 1_000, warn);
    expect(finished).toBe(true);
    await flushWithin(() => Promise.reject(new Error("disk full")), 1_000, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("close() with a stuck flushHistory still closes, right after the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gumply-close-"));
    dirs.push(dir);
    vi.spyOn(VaultStore.prototype, "flushHistory").mockReturnValue(new Promise<void>(() => undefined));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await startGumplyServer({ vaultPath: dir, port: 0, seedDemo: false, watch: false, log: () => undefined, historyFlushTimeoutMs: 100 });
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("version history flush still running"));
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
  });
});
