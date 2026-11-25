import { afterEach, expect, it, vi } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

afterEach(cleanupVaults);

/**
 * #inrd797i (@graph-dev): a scheduled rescan that was waiting for writes to finish when the store was
 * stopped must not start a refresh afterwards. It used to queue one anyway, which then ran while a
 * test's cleanup was removing the vault (and could write history into it).
 */
it("a scheduled rescan parked behind a write never starts once the store is stopped", async () => {
  const { store } = await createTestServer();
  const internal = store as unknown as {
    pendingWrites: number;
    writeQueue: Promise<unknown>;
    runScheduledRescan(): Promise<boolean>;
    refreshFromDisk(...args: unknown[]): Promise<boolean>;
  };
  const refresh = vi.spyOn(internal, "refreshFromDisk");
  let release: () => void = () => {};
  internal.writeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  internal.pendingWrites = 1;

  store.startWatching();
  const parked = internal.runScheduledRescan(); // waits for the "save" in flight
  store.stopWatching();
  internal.pendingWrites = 0;
  release();

  expect(await parked).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
