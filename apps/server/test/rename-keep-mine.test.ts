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

  it("after the rename, the link line itself edited: the user's line wins", async () => {
    const { text } = await keepMine((text) => text.replace("See [[Hub]] for more.", "See [[Hub]] for much more."), "after");
    expect(text).toContain("See [[Hub]] for much more.");
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

  it("an ordinary save from the old version is still a conflict (no merge without Keep mine)", async () => {
    const { store } = await vault();
    const target = firstLinker(store);
    const start = store.get(target);
    let refused: unknown = null;
    store.afterRenameBatch = async () => {
      if (refused) return;
      refused = await store.update(target, { content: `${start.content}x\n`, expectedUpdated: start.updated }).catch((error: unknown) => error);
    };
    await store.update("Hub", { title: "Hub renamed" });
    expect(refused).toMatchObject({ status: 409 });
  });
});
