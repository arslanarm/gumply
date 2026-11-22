import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

afterEach(cleanupVaults);

/** #jxww67d9: `GET /pages` says when the vault's linkable files changed. */
describe("X-Gumply-Files on GET /pages", () => {
  it("moves when a linkable file arrives, goes or is saved by the app, and only then", async () => {
    const server = await createTestServer();
    await writeFile(join(server.dir, "Home.md"), "![[late.png]]\n");
    await writeFile(join(server.dir, "early.png"), "x");
    const store = new VaultStore(server.dir);
    await store.init();
    const app = createApp({ vaultPath: server.dir, store });
    const version = async () => (await app.request("/api/pages")).headers.get("x-gumply-files");

    const first = await version();
    expect(first).toMatch(/^\d+$/);

    // A page edit or a new note: same files, same version.
    await writeFile(join(server.dir, "Other.md"), "Hi\n");
    await store.rescan();
    expect(await version()).toBe(first);

    // A file from outside (another app, a sync tool): a new version.
    await writeFile(join(server.dir, "late.png"), "x");
    await store.rescan();
    const second = await version();
    expect(second).not.toBe(first);

    // Ignored files (dot folders, non-attachments) don't count.
    await mkdir(join(server.dir, ".trash"), { recursive: true });
    await writeFile(join(server.dir, ".trash", "gone.png"), "x");
    await writeFile(join(server.dir, "notes.xyz"), "x");
    await store.rescan();
    expect(await version()).toBe(second);

    // A file removed: a new version.
    await rm(join(server.dir, "early.png"));
    await store.rescan();
    const third = await version();
    expect(third).not.toBe(second);

    // Saved by the app: a new version at once; the same path again: none.
    store.fileSaved("attachments/new.png");
    const fourth = await version();
    expect(fourth).not.toBe(third);
    store.fileSaved("attachments/new.png");
    expect(await version()).toBe(fourth);
  });
});
