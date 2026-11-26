import { readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, encodeId, jsonRequest } from "./helpers";

/**
 * #dqdwz9qw (seen by @opus-editor in #7prbquxu's database-grid e2e): another app saves a page with a
 * file time a few seconds in the future (a device whose clock is ahead, then a sync tool), and the server
 * kept serving the old frontmatter for 15 s or more. The change must be served, and a save from before
 * it must be a conflict (D22). Synthetic vault.
 */

afterEach(cleanupVaults);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(50);
  }
  return check();
}

const BEFORE = "---\nrole: Cook\n---\nShift notes.\n";
const AFTER = "---\nrole: Chef\n---\nShift notes.\n";

for (const how of ["in place", "as an atomic rename"] as const) {
  describe(`an outside save with a file time 5 s ahead, ${how} (#dqdwz9qw)`, () => {
    async function setup() {
      const server = await createTestServer();
      const file = join(server.dir, "Staff.md");
      await writeFile(file, BEFORE);
      await server.store.rescan();
      const version = server.store.get("Staff").updated;
      return { ...server, file, version };
    }
    async function outsideSave(file: string) {
      const ahead = new Date(Date.now() + 5_000);
      if (how === "in place") {
        await writeFile(file, AFTER);
        await utimes(file, ahead, ahead);
      } else {
        const temp = `${file}.sync-tmp`;
        await writeFile(temp, AFTER);
        await utimes(temp, ahead, ahead);
        await rename(temp, file);
      }
    }
    const roleOf = async (app: Awaited<ReturnType<typeof createTestServer>>["app"]) => {
      const response = await app.request(`/api/pages/${encodeId("Staff")}`);
      const page = (await response.json()) as { properties?: Array<{ key: string; value: unknown }>; content: string };
      return page.properties?.find((property) => property.key === "role")?.value;
    };

    it("after a rescan, the store and GET /api/pages/:id serve the new frontmatter", async () => {
      const { app, store, file } = await setup();
      await outsideSave(file);
      await store.rescan();
      expect(await roleOf(app)).toBe("Chef");
    });

    it("with the watcher on (no explicit rescan), GET serves it within the watcher's window", async () => {
      const { app, store, file } = await setup();
      store.startWatching();
      try {
        await sleep(100);
        await outsideSave(file);
        const shown = await waitFor(async () => (await roleOf(app)) === "Chef", 5000);
        expect(shown, `still ${String(await roleOf(app))} after 5 s; mtime ${(await stat(file)).mtime.toISOString()}`).toBe(true);
      } finally {
        store.stopWatching();
      }
    });

    it("a save from the version before it is a conflict, and the outside text stays", async () => {
      const { app, file, version } = await setup();
      await outsideSave(file);
      const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Staff")}`, { content: "Shift notes. Mine.", expectedUpdated: version });
      expect(response.status).toBe(409);
      expect(await readFile(file, "utf8")).toBe(AFTER);
    });
  });
}
