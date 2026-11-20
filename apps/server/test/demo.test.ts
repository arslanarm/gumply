import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCanvas, serializeCanvas } from "@gumply/core";
import { buildDemoBoard, buildDemoPages, DEMO_BOARD_TITLE, DEMO_FOLDER_TITLE, WELCOME_TITLE } from "../src/demo";
import { VaultStore } from "../src/vault-store";

const dirs: string[] = [];

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gumply-demo-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const demo = buildDemoPages();

describe("buildDemoPages", () => {
  it("creates Welcome plus a demo folder with two pages", () => {
    expect(demo.map((page) => page.title)).toEqual([
      WELCOME_TITLE,
      DEMO_FOLDER_TITLE,
      "Getting started",
      "Graph view",
    ]);
  });

  it("lists parents before children", () => {
    expect(demo[0]?.parentId).toBeNull();
    expect(demo[1]?.parentId).toBeNull();
    expect(demo[2]?.parentId).toBe("Gumply demo");
    expect(demo[3]?.parentId).toBe("Gumply demo");
  });

  it("introduces the three core interactions and links the demo pages", () => {
    const welcome = demo[0]?.content ?? "";
    expect(welcome).toContain("Type `/` for commands");
    expect(welcome).toContain("Type `[[` to link a page");
    expect(welcome).toContain("Cmd/Ctrl+K");
    expect(welcome).toContain("[[Getting started]]");
    expect(welcome).toContain("[[Graph view]]");
    expect(welcome).toContain("Your notes are plain Markdown files");
  });

  it("has a unique title per demo page", () => {
    const titles = demo.map((page) => page.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("server-side demo seeding", () => {
  it("seeds an empty vault once and announces Welcome for the first browser", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();

    expect(await store.seedDemoIfFirstRun()).toBe("Welcome");
    expect(store.list().map((page) => page.title).sort()).toEqual([
      "Getting started",
      "Graph view",
      "Gumply demo",
      "Project map",
      "Welcome",
    ]);
    expect(store.consumeNewVaultPage()).toBe("Welcome");
    expect(store.consumeNewVaultPage()).toBeNull();

    const marker = JSON.parse(
      await readFile(join(dir, ".gumply", "demo-seeded.json"), "utf8"),
    ) as { demoSeededAt?: string };
    expect(typeof marker.demoSeededAt).toBe("string");

    // A second call in the same process sees the marker.
    expect(await store.seedDemoIfFirstRun()).toBeNull();
    expect(store.list()).toHaveLength(5);
  });

  it("never re-seeds after the user deletes the demo", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    await store.seedDemoIfFirstRun();

    for (const page of store.list().filter((item) => item.parentId === null)) {
      await store.remove(page.id);
    }
    expect(store.list()).toEqual([]);

    // Simulate an app restart with the same vault: marker present, still empty.
    const reopened = new VaultStore(dir);
    await reopened.init();
    expect(await reopened.seedDemoIfFirstRun()).toBeNull();
    expect(reopened.list()).toEqual([]);
  });

  it("does not inject demo pages into an existing vault, but marks it as seen", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    await store.create({ title: "User page" });

    expect(await store.seedDemoIfFirstRun()).toBeNull();
    expect(store.list().map((page) => page.title)).toEqual(["User page"]);

    // Even if the user later deletes everything, the demo never appears.
    for (const page of store.list()) await store.remove(page.id);
    const reopened = new VaultStore(dir);
    await reopened.init();
    expect(await reopened.seedDemoIfFirstRun()).toBeNull();
    expect(reopened.list()).toEqual([]);
  });

  it("opens an existing Welcome once when upgrading a pre-marker demo vault", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    await store.create({ title: "Gumply demo" });
    await store.create({ title: "Welcome" });

    expect(await store.seedDemoIfFirstRun()).toBeNull();
    expect(store.list().map((page) => page.title).sort()).toEqual(["Gumply demo", "Welcome"]);
    expect(store.consumeNewVaultPage()).toBe("Welcome");
    expect(store.consumeNewVaultPage()).toBeNull();

    // The marker is written, so a restart must not announce (or seed) again.
    const reopened = new VaultStore(dir);
    await reopened.init();
    expect(await reopened.seedDemoIfFirstRun()).toBeNull();
    expect(reopened.consumeNewVaultPage()).toBeNull();
    expect(reopened.list()).toHaveLength(2);
  });
});

describe("demo whiteboard (#dvnb8n2n)", () => {
  it("seeds `Gumply demo/Project map.canvas` once, in Obsidian's layout", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    await store.seedDemoIfFirstRun();

    const id = `${DEMO_FOLDER_TITLE}/${DEMO_BOARD_TITLE}.canvas`;
    const doc = store.getBoard(id);
    expect(doc.meta).toMatchObject({ id, kind: "whiteboard", title: "Project map", icon: "🗺️", parentId: "Gumply demo" });
    const raw = await readFile(join(dir, "Gumply demo", "Project map.canvas"), "utf8");
    // Byte-stable: re-serialising what we read gives the same file.
    expect(serializeCanvas(parseCanvas(raw))).toBe(raw);
    expect(raw).not.toMatch(/\n$/);

    // A frame (first, behind the cards), three page cards, a sticky and a labelled arrow.
    const kinds = doc.board.nodes.map((node) => node.type);
    expect(kinds).toEqual(["group", "file", "file", "file", "text"]);
    expect(doc.board.nodes[4]).toMatchObject({ text: "Start here: double-click to add a sticky", gumply: { kind: "sticky" }, color: "3" });
    expect(doc.board.edges.find((edge) => edge.label)).toMatchObject({ label: "read next" });
    // Obsidian key order: content, gumply, then geometry, then color.
    expect(Object.keys(doc.board.nodes[4]!)).toEqual(["id", "type", "text", "gumply", "x", "y", "width", "height", "color"]);

    // Only once: a second call does nothing.
    expect(await store.seedDemoIfFirstRun()).toBeNull();
    expect(store.list().filter((meta) => meta.kind === "whiteboard")).toHaveLength(1);
  });

  it("its cards resolve, the graph has the edges, and Welcome links to it", async () => {
    const dir = await tempVault();
    const store = new VaultStore(dir);
    await store.init();
    await store.seedDemoIfFirstRun();
    const id = "Gumply demo/Project map.canvas";

    const graph = store.graph();
    const fromBoard = graph.links.filter((link) => link.source === id).map((link) => link.target).sort();
    expect(fromBoard).toEqual(["Gumply demo/Getting started", "Gumply demo/Graph view", "Welcome"]);
    expect(graph.unresolved.filter((item) => item.source === id)).toEqual([]);
    // Welcome links to the board (Obsidian-style target with alias).
    expect(graph.links).toContainEqual({ source: "Welcome", target: id });
    expect(store.get("Welcome").content).toContain("[[Project map.canvas|Project map]]");
    expect(store.backlinks(id).map((item) => item.page.id)).toEqual(["Welcome"]);
    expect(store.backlinks("Welcome").map((item) => item.page.id)).toContain(id);
  });

  it("buildDemoBoard points its cards at the demo pages' files", () => {
    const files = buildDemoBoard().nodes.flatMap((node) => (node.type === "file" ? [node.file] : []));
    expect(files).toEqual(["Welcome.md", "Gumply demo/Getting started.md", "Gumply demo/Graph view.md"]);
  });
});
