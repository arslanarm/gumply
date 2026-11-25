import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #h7j39kka: renaming a page rewrites its own self-links too (`[[Old]]`, `[[Old#H|x]]`, `![[Old#H]]`,
 * the table's `\|` form), as Obsidian does. They used to stay, pointing at no page once the session
 * redirect was gone. Only the target part changes; links to other pages that share the name's start,
 * and the page's links into its own folder (#ber4hvce's pass), behave as before. Invented names.
 */
const dirs: string[] = [];
const stores: VaultStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.stopWatching?.();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function open(dir: string) {
  const store = new VaultStore(dir, { instanceId: "install-a" });
  stores.push(store);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await store.init();
  await store.renamesResumed;
  return store;
}

const SELF = [
  "Me: [[Parent]] and [[Parent#Part|part]] and ![[Parent#Part]].",
  "Table: | [[Parent\\|x]] |",
  "Not me: [[Parent Notes]]. Code: `[[Parent]]`.",
  "",
  "## Part",
  "",
  "Text.",
  "",
].join("\n");

const MOVED = [
  "Me: [[Moved]] and [[Moved#Part|part]] and ![[Moved#Part]].",
  "Table: | [[Moved\\|x]] |",
  "Not me: [[Parent Notes]]. Code: `[[Parent]]`.",
  "",
  "## Part",
  "",
  "Text.",
  "",
].join("\n");

async function vault(withSubPage: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-rename-self-"));
  dirs.push(dir);
  await writeFile(join(dir, "Parent.md"), withSubPage ? `${SELF}Sub: [[Parent/Sub]].\n` : SELF);
  if (withSubPage) {
    await mkdir(join(dir, "Parent"));
    await writeFile(join(dir, "Parent", "Sub.md"), "A sub-page.\n");
  }
  await writeFile(join(dir, "Parent Notes.md"), "Other notes.\n");
  await writeFile(join(dir, "Other.md"), "To [[Parent]] and [[Parent#Part|p]].\n");
  return dir;
}

describe("a rename rewrites the page's own self-links (#h7j39kka)", () => {
  it("a page: its self-links follow, every other byte is kept, and the answer lists it", async () => {
    const dir = await vault(false);
    const store = await open(dir);
    const answer = await store.update("Parent", { title: "Moved" });
    expect(await readFile(join(dir, "Moved.md"), "utf8")).toBe(MOVED);
    // The answer is the page as on disk (what the editor gets), not the text from before.
    expect(answer.content).toBe(store.get("Moved").content);
    expect(answer.content).toContain("Me: [[Moved]] and [[Moved#Part|part]]");
    expect(answer.rewrittenPages).toContain("Moved");
    expect(await readFile(join(dir, "Other.md"), "utf8")).toBe("To [[Moved]] and [[Moved#Part|p]].\n");
    expect(await readFile(join(dir, "Parent Notes.md"), "utf8")).toBe("Other notes.\n");
  });

  it("a page with sub-pages: self-links and its links into its folder both follow", async () => {
    const dir = await vault(true);
    const store = await open(dir);
    const answer = await store.update("Parent", { title: "Moved" });
    expect(await readFile(join(dir, "Moved.md"), "utf8")).toBe(`${MOVED}Sub: [[Moved/Sub]].\n`);
    expect(answer.content).toBe(store.get("Moved").content);
    expect(answer.content).toContain("Sub: [[Moved/Sub]].");
    expect(answer.rewrittenPages).toContain("Moved");
  });

  it("the editor's next save from the answer goes through, with the new self-links kept", async () => {
    const dir = await vault(false);
    const store = await open(dir);
    const answer = await store.update("Parent", { title: "Moved" });
    const saved = await store.update("Moved", { content: answer.content.replace("Text.", "Text. More."), expectedUpdated: answer.updated });
    expect(saved.content).toContain("Text. More.");
    expect(await readFile(join(dir, "Moved.md"), "utf8")).toBe(MOVED.replace("Text.", "Text. More."));
  });

  it("a save from before the rename (held): never the old self-links written back", async () => {
    const dir = await vault(false);
    const store = await open(dir);
    const start = store.get("Parent");
    await store.update("Parent", { title: "Moved" });
    const edited = start.content.replace("Text.", "Text, edited.");
    const outcome = await store.update("Parent", { content: edited, expectedUpdated: start.updated }).then(
      () => "saved",
      (error: { status?: number }) => error.status ?? "error",
    );
    const onDisk = await readFile(join(dir, "Moved.md"), "utf8");
    expect(onDisk).not.toContain("[[Parent]] and");
    if (outcome === "saved") expect(onDisk).toBe(MOVED.replace("Text.", "Text, edited."));
    else expect(outcome).toBe(409);
  });

  it("a write error in the self pass never stops the other pages' rewrite (@opus-editor's review)", async () => {
    const dir = await vault(false);
    const store = await open(dir);
    const internals = store as unknown as { writeRewrittenBody: (record: { id: string }, ...rest: unknown[]) => Promise<void> };
    const real = internals.writeRewrittenBody.bind(store);
    let failed = false;
    vi.spyOn(internals, "writeRewrittenBody").mockImplementation(async (record, ...rest) => {
      if (!failed && record.id === "Moved") {
        failed = true;
        throw new Error("disk full (test)");
      }
      return real(record, ...rest);
    });
    const answer = await store.update("Parent", { title: "Moved" });
    expect(failed).toBe(true);
    expect(await readFile(join(dir, "Other.md"), "utf8")).toBe("To [[Moved]] and [[Moved#Part|p]].\n");
    expect(answer.rewrittenPages).toContain("Other");
    // The renamed page keeps its text (its self-links stay as they were), and nothing else changed.
    expect(await readFile(join(dir, "Moved.md"), "utf8")).toBe(SELF);
  });
});
