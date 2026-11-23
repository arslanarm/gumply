import { execFileSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { typedProperties, type RawProperty } from "../src/properties";
import { VaultStore } from "../src/vault-store";

/**
 * N11 (#akdzu8e6): a page open types only its own keys, parsing only the pages
 * whose frontmatter can hold them, never all of them. The result must be
 * exactly today's: every key's type from the full index (`propertyIndex()`).
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Internals = {
  beforeIndex: () => Promise<void>;
  propertyIndex: () => Promise<{ typeOf: (key: string) => string }>;
  rawPropertiesOf: (record: unknown) => Promise<RawProperty[]>;
  pages: Map<string, { kind: string }>;
};

/** A started store as the app starts it, with the link index (and so the warm-up) held until `release`. */
async function held(dir: string) {
  const store = new VaultStore(dir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  (store as unknown as Internals).beforeIndex = () => gate;
  await store.init({ background: true });
  return { store, release };
}

/** Every page's properties as the full index types them (a separate store: its own caches). */
async function fullIndexTypes(dir: string): Promise<Map<string, unknown>> {
  const store = new VaultStore(dir);
  await store.init();
  const internals = store as unknown as Internals;
  const index = await internals.propertyIndex();
  const out = new Map<string, unknown>();
  for (const [id, record] of internals.pages) {
    if (record.kind !== "page") continue;
    out.set(id, typedProperties(await internals.rawPropertiesOf(record), (key) => index.typeOf(key) as never));
  }
  return out;
}

/**
 * Open every page on a cold store (before the warm-up: the caches fill as
 * pages open, so the early pages see a cold cache, the later ones a partly
 * warm one), then again after the warm-up; both must equal the full index.
 */
async function expectEquivalent(dir: string) {
  const expected = await fullIndexTypes(dir);
  const { store, release } = await held(dir);
  const ids = [...expected.keys()];
  for (const id of ids) expect(await store.pageProperties(id), `cold: ${id}`).toEqual(expected.get(id));
  expect(store.indexing).toBe(true);
  release();
  await store.warmed;
  for (const id of ids) expect(await store.pageProperties(id), `warm: ${id}`).toEqual(expected.get(id));
  return { store, ids };
}

async function vault(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-per-key-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

describe("a page's property types from its own keys only (N11)", () => {
  it("types exactly as the full index, cold, partly warm and warm, across the edge cases", async () => {
    const dir = await vault({
      // Mixed values: the inference counts every page's value for the key, ties broken in page order.
      "A.md": "---\nscore: 1\nStatus: open\nstatus: 3\n---\nA\n",
      "B.md": "---\nscore: two\nstatus: done\n---\nB\n",
      "C.md": "---\nscore: 3\nstatus: 2026-01-02\n---\nC\n",
      // Keys are exact: `Status` and `status` are two keys (only tags and aliases go by name in any case).
      "D.md": "---\nStatus: 4\nTAGS: [x]\nAliases: [d]\n---\nD\n",
      // A quoted key, an escaped key (`s` = s: "score"), an explicit `? ` key, flow style.
      "E.md": '---\n"score": 5\n---\nE\n',
      "F.md": '---\n"\\u0073core": 6\n---\nF\n',
      "G.md": "---\n? score\n: 7\n---\nG\n",
      "H.md": "---\n{score: 8, rank: 1}\n---\nH\n",
      // A key that is part of another key, and a key only inside a value.
      "I.md": "---\nscores: 9\nnote: the score is high\n---\nI\n",
      // An anchor and a merge key, broken YAML, none at all.
      "J.md": "---\nbase: &b {score: 10}\n<<: *b\nrank: x\n---\nJ\n",
      "K.md": "---\nscore: [unclosed\n---\nK\n",
      "L.md": "No frontmatter.\n",
      // A key with a quote in it goes to the full index.
      "M.md": "---\n\"it's\": 1\n'it''s': 2\n---\nM\n",
      // Keys a substring check can't see, where they decide the type (1 text, 2 numbers → number):
      // escaped in double quotes, and folded over two lines in an explicit key.
      "N1.md": "---\nesc: x\n---\nN1\n",
      "N2.md": '---\n"\\u0065sc": 1\n---\nN2\n',
      "N3.md": '---\n"\\x65sc": 2\n---\nN3\n',
      "O1.md": "---\nq k: x\n---\nO1\n",
      "O2.md": '---\n? "q\n  k"\n: 1\n---\nO2\n',
      "O3.md": "---\n? q\n  k\n: 2\n---\nO3\n",
      // A conflict copy's values never count.
      "A.sync-conflict-20261122-143005-ABCDEFG.md": "---\nscore: copy\nstatus: copy\n---\nA\n",
    });
    await expectEquivalent(dir);
  });

  it("a stored type wins; a page edited after the scan is read as it is now", async () => {
    const dir = await vault({
      "A.md": "---\nscore: 1\nlevel: 1\n---\nA\n",
      "B.md": "---\nscore: x\nlevel: 2\n---\nB\n",
      "C.md": "---\nlevel: 3\n---\nC\n",
    });
    const { store, release } = await held(dir);
    // Edited after the scan kept its YAML: the substring check must not trust the old text.
    await writeFile(join(dir, "C.md"), "---\nlevel: three\nscore: y\n---\nC\n");
    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "C.md"), later, later);
    await store.rescan();
    await store.setPropertyType("level", "number");
    const props = await store.pageProperties("A");
    expect(props?.find((p) => p.key === "level")?.type).toBe("number");
    // score: 1, x, y → text (two of three), as the full index says.
    expect(props?.find((p) => p.key === "score")?.type).toBe("text");
    release();
    await store.warmed;
    const expected = await fullIndexTypes(dir);
    for (const id of ["A", "B", "C"]) expect(await store.pageProperties(id), id).toEqual(expected.get(id));
  });

  it("a first open parses only the pages that can hold its keys", async () => {
    const files: Record<string, string> = { "Open.md": "---\nrare: 1\n---\nOpen\n" };
    for (let i = 0; i < 200; i++) files[`Note ${i}.md`] = `---\nstatus: s${i}\npriority: ${i}\n${i % 50 === 0 ? "rare: 2\n" : ""}---\nBody ${i}.\n`;
    const dir = await vault(files);
    const { store, release } = await held(dir);
    store.propertyYamlParses = 0;
    store.propertyFileReads = 0;
    const props = await store.pageProperties("Open");
    expect(props?.find((p) => p.key === "rare")?.type).toBe("number");
    // The page itself and the 4 notes with `rare`: not the 200.
    expect(store.propertyYamlParses).toBe(5);
    expect(store.propertyFileReads).toBe(0);
    release();
    await store.warmed;
  });
});

/**
 * On the perf vault (scripts/perf/make-vault.mjs): 2,000 notes always; the
 * 10k vault with GUMPLY_N11_10K=1 (slow: run once per change, not in CI).
 * Its `.obsidian/types.json` types every key, so it is removed: every key
 * is inferred, which is the case the per-key collection changes.
 */
describe("equivalence on the perf vault (N11)", () => {
  const notes = process.env.GUMPLY_N11_10K === "1" ? 10_000 : 2_000;
  it(`${notes} notes: every page typed exactly as the full index, cold and warm`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "gumply-per-key-perf-"));
    dirs.push(parent);
    const dir = join(parent, "vault");
    const script = fileURLToPath(new URL("../../../scripts/perf/make-vault.mjs", import.meta.url));
    execFileSync(process.execPath, [script, dir, "--notes", String(notes)], { stdio: "ignore" });
    await rm(join(dir, ".obsidian", "types.json"), { force: true });
    const { ids } = await expectEquivalent(dir);
    expect(ids.length).toBeGreaterThan(notes);
  }, 600_000);
});
