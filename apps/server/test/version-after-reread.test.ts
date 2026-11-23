import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #2xx3uae4: the version a save answers with must be the version a later read
 * of the same file gives (a server restart, another process). It wasn't for a
 * note with an `updated:` key: a save answered with that key, a read with the
 * newer file time, so the open editor's next save after a server restart was a
 * false "This page changed on disk".
 *
 * The clock (Date only) is set back while saving, so the `updated:` written is
 * clearly older than the file's real mtime, as a slow disk or a coarse clock
 * makes it by a millisecond or two.
 */
afterEach(async () => {
  vi.useRealTimers();
  await cleanupVaults();
});

describe("a save's version is the version a fresh read gives", () => {
  it("a note with frontmatter: the next save after a server restart, with the saved version, isn't a conflict", async () => {
    const { store, dir } = await createTestServer();
    const created = await store.create({ title: "Plan", content: "First." });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const saved = await store.update(created.id, { content: "Second.", expectedUpdated: created.updated });
    vi.useRealTimers();
    store.stopWatching();

    const restarted = new VaultStore(dir);
    await restarted.init();
    expect(restarted.get(created.id).updated).toBe(saved.updated);
    const next = await restarted.update(created.id, { content: "Third.", expectedUpdated: saved.updated });
    expect(next.content).toContain("Third.");
    restarted.stopWatching();
  });

  it("a new page: the first save after a server restart, with the version it was created with, isn't a conflict", async () => {
    const { store, dir } = await createTestServer();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const created = await store.create({ title: "Fresh", content: "First." });
    vi.useRealTimers();
    store.stopWatching();

    const restarted = new VaultStore(dir);
    await restarted.init();
    expect(restarted.get(created.id).updated).toBe(created.updated);
    const next = await restarted.update(created.id, { content: "Second.", expectedUpdated: created.updated });
    expect(next.content).toContain("Second.");
    restarted.stopWatching();
  });
});
