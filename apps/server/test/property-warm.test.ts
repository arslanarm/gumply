import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNoteTemplate } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { frontmatterYaml, VaultStore } from "../src/vault-store";

/**
 * #kguq5bc5: the first page opened after a start read every page's
 * frontmatter again (about 10k files on a big vault) for the properties index.
 * The scan keeps each page's YAML; the index parses from it and the background
 * warm-up fills the cache, so a page open never reads files for properties.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vault(pages = 60) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-prop-warm-"));
  dirs.push(dir);
  for (let i = 0; i < pages; i++) {
    await writeFile(join(dir, `Note ${i}.md`), `---\nstatus: ${i % 2 ? "open" : "done"}\npriority: ${i}\ntags: [a]\n---\nBody ${i}.\n`);
  }
  await writeFile(join(dir, "Plain.md"), "No frontmatter here.\n");
  const store = new VaultStore(dir);
  // As the app starts it: answers first, links indexed and caches warmed in the background.
  await store.init({ background: true });
  return { dir, store, app: createApp({ vaultPath: dir, store }) };
}

const propertiesOf = async (app: ReturnType<typeof createApp>, id: string) =>
  ((await (await app.request(`/api/pages/${encodeURIComponent(id)}`)).json()) as { properties?: Array<{ key: string; value: unknown; type: string }> }).properties ?? [];

describe("frontmatterYaml", () => {
  it("gives exactly parseNoteTemplate's YAML, reading only the head", () => {
    const samples = [
      "---\ntitle: A\ntags: [x]\n---\nBody\n---\nnot frontmatter\n",
      "﻿---\r\nstatus: open\r\n---\r\nBody\r\n",
      "---\nkey: value\n---",
      "---\n---\nBody\n",
      "---\n  \n---\nBody\n",
      "---\nno closing fence\nBody\n",
      "No frontmatter\n---\nkey: x\n---\n",
      "--- \nspaced: fence\n---   \nBody\n",
      "",
    ];
    for (const raw of samples) expect(frontmatterYaml(raw), JSON.stringify(raw)).toBe(parseNoteTemplate(raw).yaml);
  });
});

describe("the properties index never reads page files on a page open (#kguq5bc5)", () => {
  it("once warm: GET /pages/:id and the vault's property list read 0 files", async () => {
    const { store, app } = await vault();
    await store.warmed;
    store.propertyFileReads = 0;
    const props = await propertiesOf(app, "Note 7");
    expect(props.find((p) => p.key === "status")).toMatchObject({ value: "open", type: "text" });
    expect(props.find((p) => p.key === "priority")).toMatchObject({ value: 7, type: "number" });
    await app.request("/api/properties");
    expect(store.propertyFileReads).toBe(0);
  });

  it("cold, before the warm-up: still 0 file reads (the scan's YAML is parsed instead)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gumply-prop-warm-"));
    dirs.push(dir);
    for (let i = 0; i < 60; i++) await writeFile(join(dir, `Note ${i}.md`), `---\nstatus: ${i % 2 ? "open" : "done"}\n---\nBody ${i}.\n`);
    const store = new VaultStore(dir);
    // Hold the link index (and so the warm-up after it): the page open really comes first.
    let release!: () => void;
    (store as unknown as { beforeIndex: () => Promise<void> }).beforeIndex = () => new Promise<void>((resolve) => (release = resolve));
    await store.init({ background: true });
    const app = createApp({ vaultPath: dir, store });
    store.propertyFileReads = 0;
    const props = await propertiesOf(app, "Note 4");
    expect(store.indexing).toBe(true);
    expect(props.find((p) => p.key === "status")).toMatchObject({ value: "done" });
    expect(store.propertyFileReads).toBe(0);
    release();
    await store.warmed;
  });

  it("a page changed outside after the scan shows its new properties (nothing stale)", async () => {
    const { dir, store, app } = await vault(10);
    await store.warmed;
    const file = join(dir, "Note 3.md");
    await writeFile(file, "---\nstatus: blocked\npriority: 3\n---\nBody 3.\n");
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    await store.rescan();
    expect((await propertiesOf(app, "Note 3")).find((p) => p.key === "status")).toMatchObject({ value: "blocked" });
  });

  it("a property set in Gumply shows at once", async () => {
    const { store, app } = await vault(10);
    await store.warmed;
    const page = store.get("Note 5");
    await store.update("Note 5", { properties: { set: { status: "review" } }, expectedUpdated: page.updated });
    expect((await propertiesOf(app, "Note 5")).find((p) => p.key === "status")).toMatchObject({ value: "review" });
  });

  it("the warm-up parses every page's properties, so the cache is full and the scan's YAML is freed", async () => {
    const { store } = await vault(40);
    await store.warmed;
    const internals = store as unknown as { rawPropertyCache: Map<string, unknown>; scanYaml: Map<string, unknown> };
    expect(internals.rawPropertyCache.size).toBeGreaterThanOrEqual(41);
    expect(internals.scanYaml.size).toBe(0);
  });
});
