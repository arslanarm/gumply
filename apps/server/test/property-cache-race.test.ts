import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #dqdwz9qw (@opus-editor's same-size, same-mtime case, intermittent in the e2e): a page's
 * properties are cached by path and file time, and the cache is filled after an awaited read. A read
 * that started before an outside write (the page API being polled) can finish after the refresh has
 * re-read the file, and put the OLD properties back under the same file time: every later read then
 * serves them. Made deterministic here by holding that one read (a one-shot gate on readFile).
 */

const gate = vi.hoisted(() => ({ path: "", armed: false, release: null as null | (() => void), reached: null as null | (() => void) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      const bytes = await real.readFile(...args);
      if (gate.armed && String(args[0]) === gate.path) {
        // One-shot: this read got the old bytes; it finishes only when the test says so.
        gate.armed = false;
        gate.reached?.();
        await new Promise<void>((resolve) => (gate.release = resolve));
      }
      return bytes;
    }) as typeof real.readFile,
  };
});

afterEach(cleanupVaults);

describe("the properties cache never serves an older file's properties (#dqdwz9qw)", () => {
  it("a read that started before a same-size, same-mtime outside write and ends after the refresh doesn't put the old properties back", async () => {
    const { store, dir } = await createTestServer();
    const file = join(dir, "Ann.md");
    await writeFile(file, "---\nrole: Cook\nage: 30\n---\nAnn\n");
    await store.rescan();
    const role = async () => (await store.pageProperties("Ann"))?.find((property) => property.key === "role")?.value;

    // A properties read of the old file is under way (the page API being polled)...
    gate.path = file;
    gate.armed = true;
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    // The scan's cached YAML is used once; drop it so this read goes to the file, as a later poll's does.
    (store as unknown as { scanYaml: Map<string, unknown> }).scanYaml.delete(file);
    (store as unknown as { rawPropertyCache: Map<string, unknown> }).rawPropertyCache.delete(file);
    const early = store.pageProperties("Ann");
    await reached;

    // ...another app writes the same size with the time put back, and the refresh re-reads it.
    const { atime, mtime } = await stat(file);
    await writeFile(file, "---\nrole: Chef\nage: 30\n---\nAnn\n");
    await utimes(file, atime, mtime);
    await store.rescan();
    expect(await role()).toBe("Chef");

    // The early read now finishes with the old bytes.
    gate.release?.();
    await early;
    expect(await role(), "a later read must still see the file as it is").toBe("Chef");
  });
});
