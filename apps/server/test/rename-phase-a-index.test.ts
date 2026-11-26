import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkEdge } from "@gumply/core";
import { VaultStore } from "../src/vault-store";

/**
 * #6pyunynv (measured in #ndp6qqxz): a batched title rename rebuilt the whole link index twice, once in
 * its first step (before any linking page was written, ~1.3 s on the 10k vault) and again at its end. In
 * the batched path the first one only needs the edges that pointed at the old id moved to the new one (the
 * rename's alias), the renamed page's own edges, and the links that didn't resolve before and now name the
 * page. These tests pin: one full rebuild per batched rename; the first step's index is exactly what a full
 * rebuild gives; backlinks mid-rename are complete, including a `[[New name]]` that was unresolved before.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vault(linkers: number, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-rename-phase-a-"));
  dirs.push(dir);
  await writeFile(join(dir, "Hub.md"), "The hub. Back to [[Hub]].\n");
  await mkdir(join(dir, "L"));
  await Promise.all(Array.from({ length: linkers }, (_, i) => writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Hub]] (${i}).\n`)));
  for (const [name, body] of Object.entries(extra)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  const store = new VaultStore(dir);
  await store.init();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { dir, store };
}

type Internals = { reindexAll: () => void; edgesBySource: Map<string, LinkEdge[]> };
const internals = (store: VaultStore) => store as unknown as Internals;
/** The index as comparable data: sources sorted, each source's edges as written. */
const indexOf = (store: VaultStore) =>
  [...internals(store).edgesBySource].map(([source, edges]) => [source, edges.map((edge) => ({ ...edge }))] as const).sort(([a], [b]) => a.localeCompare(b));

describe("a batched rename's first step updates the link index without a full rebuild (#6pyunynv)", { timeout: 60_000 }, () => {
  it("one full rebuild per batched rename (at its end), not two", async () => {
    const { store } = await vault(300);
    const full = vi.spyOn(internals(store), "reindexAll");
    await store.update("Hub", { title: "Hub renamed" });
    expect(full).toHaveBeenCalledTimes(1);
    expect(new Set(store.backlinks("Hub renamed").map((link) => link.page.id)).size).toBe(300);
  });

  it("mid-rename, the index is exactly what a full rebuild gives, and backlinks are complete, an unresolved [[New name]] included", async () => {
    const { store } = await vault(300, { "Waiting.md": "Soon: [[Hub renamed]].\n", "Elsewhere.md": "Unrelated [[Nowhere]].\n" });
    let checked = false;
    store.afterRenameBatch = async () => {
      if (checked) return;
      checked = true;
      const incremental = indexOf(store);
      internals(store).reindexAll();
      expect(incremental).toEqual(indexOf(store));
      const linkers = new Set(store.backlinks("Hub renamed").map((link) => link.page.id));
      expect(linkers.size).toBe(301);
      expect(linkers.has("Waiting")).toBe(true);
    };
    await store.update("Hub", { title: "Hub renamed" });
    expect(checked).toBe(true);
  });

  /** At the rename's first batch, the index must equal a full rebuild (checked once per rename). */
  function checkAtFirstBatch(store: VaultStore) {
    let checked = false;
    store.afterRenameBatch = async () => {
      if (checked) return;
      checked = true;
      const incremental = indexOf(store);
      internals(store).reindexAll();
      expect(incremental).toEqual(indexOf(store));
    };
    return () => checked;
  }

  it("@opus-hunter's cases: a link that resolved to another page and now resolves to the renamed one (.md fallback, spacing, NFD, a slug-form file name) follows exactly as in a full rebuild", async () => {
    const { store } = await vault(5, {
      "F/Source.md": "By file: [[Beta.md]]. Spaced: [[beta  page]]. Accented: [[Cafe\u0301]]. Slug: [[omega point]].\n",
      // @opus-hunter: a slug-form file name too, so both pages match [[omega point]] at the same (slug) step
      // and only the folder preference decides; a title match ("Omega Point") would win before any slug check.
      "Other/omega-point.md": "The other omega-point.\n",
      "F/Epsilon.md": "To be omega-point (a slug-form file name).\n",
      "Other/Beta.md": "The other Beta.\n",
      "Other/Beta Page.md": "The other Beta Page.\n",
      "Other/Café.md": "The other café.\n",
      "F/Alpha.md": "To be Beta.\n",
      "F/Gamma.md": "To be Beta Page.\n",
      "F/Delta.md": "To be Café.\n",
    });
    for (const [from, to] of [["F/Alpha", "Beta"], ["F/Gamma", "Beta Page"], ["F/Delta", "Café"], ["F/Epsilon", "omega-point"]] as const) {
      const checked = checkAtFirstBatch(store);
      await store.update(from, { title: to });
      expect(checked(), `${from} → ${to}`).toBe(true);
    }
  });

  it("a rename that starts while the cold-open index is still running: the index at its first batch has no holes (a full rebuild, @opus-hunter's point 2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gumply-rename-phase-a-"));
    dirs.push(dir);
    await writeFile(join(dir, "Hub.md"), "The hub.\n");
    await mkdir(join(dir, "L"));
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Hub]] (${i}).\n`)));
    const store = new VaultStore(dir);
    const raw = store as unknown as { indexSliceMs: number; beforeIndex: () => Promise<void> };
    raw.indexSliceMs = 0; // one page per slice: the rename starts with most pages not indexed yet
    let renaming: Promise<unknown> = Promise.resolve();
    raw.beforeIndex = async () => {
      setImmediate(() => {
        renaming = store.update("Hub", { title: "Hub renamed" });
      });
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const checked = checkAtFirstBatch(store);
    await store.init({ background: true });
    await vi.waitFor(() => expect(checked()).toBe(true), { timeout: 20_000, interval: 10 });
    await renaming;
  });
});

