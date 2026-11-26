import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * N10 (#5pgmziyc): someone is typing in page X while a rename of Hub rewrites
 * X's [[Hub]]. Their next save is a conflict; Keep mine (a forced save from
 * the version they started from) used to write [[Hub]] back. Now it keeps
 * their text and the rename's link changes on the lines they didn't touch.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "gumply-keep-mine-"));
  dirs.push(dir);
  await writeFile(join(dir, "Hub.md"), "The hub.\n");
  await mkdir(join(dir, "L"));
  for (let i = 0; i < 450; i++) await writeFile(join(dir, "L", `Linker ${i}.md`), `Intro ${i}.\nSee [[Hub]] for more.\nNotes.\n`);
  const store = new VaultStore(dir);
  await store.init();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { dir, store };
}

const firstLinker = (store: VaultStore) => [...(store as unknown as { pages: Map<string, unknown> }).pages.keys()].filter((id) => id.startsWith("L/"))[0]!;

/**
 * Rename Hub while an editor holds page X at its pre-rename version. The editor's save meets the
 * conflict; Keep mine is sent `when`: during the rename (after X's batch ran) or after it ended.
 */
async function keepMine(edit: (text: string) => string, when: "during" | "after", options: { minutesLater?: number } = {}) {
  const { dir, store } = await vault();
  const target = firstLinker(store);
  const start = store.get(target);
  const send = async () => {
    if (options.minutesLater) {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + options.minutesLater * 60_000);
    }
    await store.update(target, { content: edit(start.content), expectedUpdated: start.updated, force: true });
  };
  let sent = false;
  if (when === "during") {
    store.afterRenameBatch = async () => {
      if (sent) return;
      sent = true;
      expect(store.get(target).content).toContain("[[Hub renamed]]"); // its batch ran
      await send();
    };
  }
  await store.update("Hub", { title: "Hub renamed" });
  if (when === "after") await send();
  return { text: await readFile(join(dir, `${target}.md`), "utf8"), store, target };
}

describe("Keep mine during a rename keeps the rename's link changes (N10)", { timeout: 60_000 }, () => {
  it("Keep mine after the rename ended: the typing and [[Hub renamed]]", async () => {
    const { text, store, target } = await keepMine((text) => text.replace(/^Intro (\d+)\./, "Intro $1, edited."), "after");
    expect(text).toMatch(/Intro \d+, edited\./);
    expect(text).toContain("See [[Hub renamed]] for more.");
    expect(text).not.toContain("[[Hub]]");
    expect(store.backlinks("Hub renamed").map((link) => link.page.id)).toContain(target);
  });

  it("after the rename, a [[Hub]] the user typed on a new line is kept (it may mean a new page)", async () => {
    const { text } = await keepMine((text) => `${text}About a new one: [[Hub]].\n`, "after");
    expect(text).toContain("See [[Hub renamed]] for more.");
    expect(text).toContain("About a new one: [[Hub]].");
  });

  it("after the rename, the link line itself edited: the user's line, with the rename's link inside it (#z9hufufn)", async () => {
    const { text } = await keepMine((text) => text.replace("See [[Hub]] for more.", "See [[Hub]] for much more."), "after");
    expect(text).toContain("See [[Hub renamed]] for much more.");
  });

  it("after the rename, the link itself edited by the user: their link as written (#z9hufufn)", async () => {
    const { text } = await keepMine((text) => text.replace("See [[Hub]] for more.", "See [[Other]] for more."), "after");
    expect(text).toContain("See [[Other]] for more.");
  });

  it("after the 10-minute window: the user's text as sent (as before)", async () => {
    const { text } = await keepMine((text) => text.replace(/^Intro (\d+)\./, "Intro $1, late."), "after", { minutesLater: 11 });
    expect(text).toMatch(/Intro \d+, late\./);
    expect(text).toContain("See [[Hub]] for more.");
  });

  it("Keep mine while the rename still runs: the typing and [[Hub renamed]] (N9-1's final pass sees the page as touched)", async () => {
    const { text } = await keepMine((text) => text.replace(/^Intro (\d+)\./, "Intro $1, edited mid-rename."), "during");
    expect(text).toMatch(/Intro \d+, edited mid-rename\./);
    expect(text).toContain("See [[Hub renamed]] for more.");
  });

  it("an ordinary save from the old version that only the rename changed since: merged, not a conflict (#z9hufufn)", async () => {
    const { dir, store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    let answer: unknown = null;
    store.afterRenameBatch = async () => {
      if (answer || !store.get(target).content.includes("[[Hub renamed]]")) return; // after its batch ran
      answer = await store.update(target, { content: `${start.content}x`, expectedUpdated: start.updated }).catch((error: unknown) => error);
    };
    await store.update("Hub", { title: "Hub renamed" });
    expect(answer).toMatchObject({ renameLinksMerged: { links: 1, titles: ["Hub renamed"] } });
    const text = await readFile(join(dir, `${target}.md`), "utf8");
    expect(text).toContain("See [[Hub renamed]] for more.");
    expect(text).toMatch(/\nx\n?$/);
  });

  it("an ordinary save the rename's change can't be carried into (the link typed twice on its line): still a conflict, never a partial merge (#z9hufufn, @lead)", async () => {
    const { dir, store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    await store.update("Hub", { title: "Hub renamed" });
    const sent = start.content.replace("See [[Hub]] for more.", "See [[Hub]] for more, and [[Hub]] again.");
    const refused = await store.update(target, { content: sent, expectedUpdated: start.updated }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409 });
    expect(await readFile(join(dir, `${target}.md`), "utf8")).toContain("See [[Hub renamed]] for more.");
  });

  it("an ordinary save from the old version after a real outside change too: still a conflict (#z9hufufn, the control)", async () => {
    const { dir, store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    await store.update("Hub", { title: "Hub renamed" });
    // Another program edits the file after the rename (the store hasn't re-read it yet).
    const file = join(dir, `${target}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace("Notes.", "Notes, from outside."));
    const refused = await store.update(target, { content: `${start.content}x`, expectedUpdated: start.updated }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409 });
    expect(await readFile(file, "utf8")).toContain("Notes, from outside.");
  });

  it("Keep mine's backup is still the exact version it replaced (the rename's), and only link lines differ from what was sent", async () => {
    const { dir, store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    await store.update("Hub", { title: "Hub renamed" });
    const onDisk = await readFile(join(dir, `${target}.md`));
    const sent = start.content.replace(/^Intro (\d+)\./, "Intro $1, mine.");
    const saved = await store.update(target, { content: sent, expectedUpdated: start.updated, force: true });
    // The backup in .gumply/conflicts/ holds the replaced file byte for byte, as before N10.
    expect(saved.conflictBackup).toBeTruthy();
    expect((await readFile(join(dir, saved.conflictBackup!))).equals(onDisk)).toBe(true);
    // What was written is what was sent, except the rename's link line (which the user didn't touch).
    const written = store.get(target).content;
    const sentLines = sent.split("\n");
    const writtenLines = written.split("\n");
    expect(writtenLines).toHaveLength(sentLines.length);
    const differing = sentLines.flatMap((line, i) => (line === writtenLines[i] ? [] : [[line, writtenLines[i]]]));
    expect(differing).toEqual([["See [[Hub]] for more.", "See [[Hub renamed]] for more."]]);
  });

  it("Keep mine's answer says which links were kept; an ordinary save afterwards writes what was sent", async () => {
    const { dir, store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    await store.update("Hub", { title: "Hub renamed" });
    const mine = start.content.replace(/^Intro (\d+)\./, "Intro $1, mine.");
    const kept = await store.update(target, { content: mine, expectedUpdated: start.updated, force: true, writer: "w1" });
    expect(kept.renameLinksMerged).toEqual({ links: 1, titles: ["Hub renamed"] });
    // The same editor's next ordinary save, still with [[Hub]] (a client that didn't apply the answer):
    // written as sent, and its answer reports no merge. Keeping the new link is the client's job.
    const next = await store.update(target, { content: `${mine}More typing.\n`, expectedUpdated: kept.updated, writer: "w1" });
    expect(next.renameLinksMerged).toBeUndefined();
    const text = await readFile(join(dir, `${target}.md`), "utf8");
    expect(text).toContain("See [[Hub]] for more.");
    expect(text).toContain("More typing.");
    expect(text).not.toContain("[[Hub renamed]]");
  });

  it("a deliberate [[Hub]] put back by an ordinary save after a merge is written as sent", async () => {
    const { dir, store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    await store.update("Hub", { title: "Hub renamed" });
    const kept = await store.update(target, { content: start.content, expectedUpdated: start.updated, force: true, writer: "w1" });
    // Someone deliberately writes [[Hub]] back on that line, from the current version: kept as sent.
    await store.update(target, { content: start.content, expectedUpdated: kept.updated, writer: "w2" });
    expect(await readFile(join(dir, `${target}.md`), "utf8")).toContain("See [[Hub]] for more.");
  });
});
