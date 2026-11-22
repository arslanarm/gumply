import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultImage } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, getJson } from "./helpers";

afterEach(cleanupVaults);

describe("GET /files/images (#3ht5gh6q)", () => {
  it("lists every image in the vault, newest first, never dot folders or the trash", async () => {
    const server = await createTestServer();
    const files: Record<string, number> = {
      "root.png": 1000,
      "att/photo.jpg": 3000,
      "Notes/deep/nested.webp": 2000,
      "attachments/old.gif": 500,
      "same-time-b.png": 4000,
      "same-time-a.png": 4000,
      ".obsidian/icon.png": 9000,
      ".trash/x/gone.png": 9000,
      ".gumply/conflicts/c.png": 9000,
      "att/report.pdf": 9000,
    };
    for (const [path, seconds] of Object.entries(files)) {
      await mkdir(join(server.dir, path, ".."), { recursive: true });
      await writeFile(join(server.dir, path), "x");
      await utimes(join(server.dir, path), seconds, seconds);
    }
    await writeFile(join(server.dir, "Home.md"), "Hi\n");
    const store = new VaultStore(server.dir);
    await store.init();
    const app = createApp({ vaultPath: server.dir, store });

    const images = await getJson<VaultImage[]>(app, "/api/files/images");
    expect(images.map((image) => image.path)).toEqual([
      "same-time-a.png",
      "same-time-b.png",
      "att/photo.jpg",
      "Notes/deep/nested.webp",
      "root.png",
      "attachments/old.gif",
    ]);
    expect(images[2]).toEqual({ path: "att/photo.jpg", name: "photo.jpg", modified: new Date(3000 * 1000).toISOString() });
  });
});

describe("GET /files/linkable (#4usgpjh8)", () => {
  it("lists every linkable file with the link Obsidian writes from the note", async () => {
    const server = await createTestServer();
    const files: Record<string, string> = {
      "att/mountain.png": "x",
      "Plan.png": "x",
      "Projects/pic.png": "x",
      "Notes/img/pic.png": "x",
      "Files/report.pdf": "x",
      ".trash/x/gone.png": "x",
      "Plan.md": "Plan page\n",
      "Notes/Day.md": "Day\n",
    };
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(server.dir, path, ".."), { recursive: true });
      await writeFile(join(server.dir, path), body);
    }
    const store = new VaultStore(server.dir);
    await store.init();
    const app = createApp({ vaultPath: server.dir, store });

    const links = (list: Array<{ path: string; link: string }>) => Object.fromEntries(list.map((file) => [file.path, file.link]));
    const fromRoot = await getJson<Array<{ path: string; link: string }>>(app, "/api/files/linkable?from=Plan");
    expect(links(fromRoot)).toEqual({
      "att/mountain.png": "mountain.png",
      // The page Plan.md doesn't compete with Plan.png.
      "Plan.png": "Plan.png",
      "Projects/pic.png": "pic.png",
      "Notes/img/pic.png": "Notes/img/pic.png",
      "Files/report.pdf": "report.pdf",
    });
    // From a note in Notes/, its folder's copy takes the bare name.
    const fromNotes = await getJson<Array<{ path: string; link: string }>>(app, `/api/files/linkable?from=${encodeURIComponent("Notes/Day")}`);
    expect(links(fromNotes)["Notes/img/pic.png"]).toBe("pic.png");
    expect(links(fromNotes)["Projects/pic.png"]).toBe("Projects/pic.png");
  });
});
