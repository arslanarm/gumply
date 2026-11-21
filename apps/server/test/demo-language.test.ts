import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractWikilinks, parseCanvas } from "@gumply/core";
import { buildDemoBoard, buildDemoPages, DEMO_LANGUAGES, demoCopy, demoLanguageFor } from "../src/demo";
import { cleanupVaults, createTestServer } from "./helpers";

/** #93yv3ban: the demo vault in the interface language of the first run. */

afterEach(cleanupVaults);

describe("demo copy per language", () => {
  it("ships English and Russian with the same structure", () => {
    expect(DEMO_LANGUAGES).toEqual(expect.arrayContaining(["en", "ru"]));
    const shape = (language: string) =>
      buildDemoPages(language).map((page) => [page.icon, page.parentId === null, page.content.split("\n").length]);
    expect(shape("ru")).toEqual(shape("en"));
    expect(buildDemoPages("ru").map((page) => page.title)).toEqual(["Добро пожаловать", "Демо Gumply", "Начало работы", "Граф связей"]);
  });

  for (const language of ["en", "ru"]) {
    it(`${language}: every link and board card points at a demo page or the board`, () => {
      const copy = demoCopy(language);
      const titles = new Set(buildDemoPages(language).map((page) => page.title));
      for (const page of buildDemoPages(language)) {
        for (const link of extractWikilinks(page.content)) {
          expect(titles.has(link.targetTitle) || link.targetTitle === `${copy.board}.canvas`, `${page.title} → ${link.targetTitle}`).toBe(true);
        }
      }
      const files = buildDemoBoard(language).nodes.flatMap((node) => (node.type === "file" ? [node.file] : []));
      expect(files).toEqual([`${copy.welcome}.md`, `${copy.folder}/${copy.gettingStarted}.md`, `${copy.folder}/${copy.graphView}.md`]);
      // Valid JSON Canvas.
      expect(parseCanvas(JSON.stringify(buildDemoBoard(language))).nodes).toHaveLength(5);
    });
  }

  it("unknown languages fall back to English", () => {
    expect(buildDemoPages("de")).toEqual(buildDemoPages("en"));
  });

  it("reads Accept-Language: the first language the demo has, by quality", () => {
    expect(demoLanguageFor("ru")).toBe("ru");
    expect(demoLanguageFor("ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(demoLanguageFor("de-DE,ru;q=0.5,en;q=0.7")).toBe("en");
    expect(demoLanguageFor("de, fr")).toBe("en");
    expect(demoLanguageFor("en;q=0, ru;q=0.1")).toBe("ru");
    expect(demoLanguageFor(undefined)).toBe("en");
  });
});

describe("seeding on the first GET /pages", () => {
  const list = (app: Awaited<ReturnType<typeof createTestServer>>["app"], language?: string) =>
    app.request("/api/pages", language ? { headers: { "Accept-Language": language } } : {});

  it("seeds in Russian when the first request asks for it, once, and lands on Welcome", async () => {
    const { app, dir, store } = await createTestServer();
    store.armDemo(() => undefined);
    // Two first requests at once: one demo.
    const [first, second] = await Promise.all([list(app, "ru"), list(app, "en")]);
    const pages = (await first.json()) as Array<{ title: string }>;
    expect(pages.map((page) => page.title).sort()).toEqual(
      ["Граф связей", "Демо Gumply", "Добро пожаловать", "Карта проекта", "Начало работы"].sort(),
    );
    expect(((await second.json()) as unknown[]).length).toBe(5);
    // Percent-encoded: a header carries bytes.
    expect([first.headers.get("x-gumply-new-vault"), second.headers.get("x-gumply-new-vault")]).toContain(
      encodeURIComponent("Добро пожаловать"),
    );
    expect((await readdir(dir)).sort()).toEqual([".gumply", "Добро пожаловать.md", "Демо Gumply", "Демо Gumply.md"].sort());
    const welcome = await readFile(join(dir, "Добро пожаловать.md"), "utf8");
    expect(welcome).toContain("[[Начало работы]] · [[Граф связей]]");
    expect(welcome).toContain("[[Карта проекта.canvas|Карта проекта]]");
    const board = JSON.parse(await readFile(join(dir, "Демо Gumply", "Карта проекта.canvas"), "utf8")) as { nodes: Array<{ file?: string }> };
    expect(board.nodes.flatMap((node) => (node.file ? [node.file] : []))).toContain("Демо Gumply/Начало работы.md");
  });

  it("seeds in English for other languages or no header", async () => {
    for (const language of ["de-DE", undefined]) {
      const { app, store } = await createTestServer();
      store.armDemo(() => undefined);
      const pages = (await (await list(app, language)).json()) as Array<{ title: string }>;
      expect(pages.map((page) => page.title)).toContain("Welcome");
    }
  });

  it("only the app's own request seeds: a GET from another origin is refused and seeds nothing", async () => {
    const { app, dir, store } = await createTestServer();
    store.armDemo(() => undefined);
    const foreign = await app.request("/api/pages", { headers: { Origin: "https://evil.example", "Accept-Language": "ru" } });
    expect(foreign.status).toBe(403);
    expect(await readdir(dir)).toEqual([]);
    // The app's own request still seeds, in its language.
    const own = (await (await list(app, "ru")).json()) as Array<{ title: string }>;
    expect(own.map((page) => page.title)).toContain("Добро пожаловать");
  });

  it("no-cors GETs, navigations and cross-site requests never seed nor take the Welcome signal (@opus-hunter's P3)", async () => {
    const { app, dir, store } = await createTestServer();
    store.armDemo(() => undefined);
    const headers = [
      { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors" }, // <img src> from another port
      { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" }, // typed into the address bar
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
      // Allow-list: a mode or site this server doesn't know never seeds.
      { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "some-future-mode" },
      { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors" },
    ];
    for (const extra of headers) {
      const response = await app.request("/api/pages", { headers: { ...extra, "Accept-Language": "en" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(response.headers.get("x-gumply-new-vault")).toBeNull();
    }
    expect(await readdir(dir)).toEqual([]);
    // The app's own fetch still seeds, in its language, and gets the signal.
    const own = await app.request("/api/pages", {
      headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Accept-Language": "ru" },
    });
    expect(((await own.json()) as Array<{ title: string }>).map((page) => page.title)).toContain("Добро пожаловать");
    expect(own.headers.get("x-gumply-new-vault")).toBe(encodeURIComponent("Добро пожаловать"));
  });

  it("never seeds a folder that already has files (#pc3wvc2u), nor without arming", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "report.pdf"), "%PDF-1.4");
    store.armDemo(() => undefined);
    expect(await (await list(app, "ru")).json()).toEqual([]);

    const plain = await createTestServer();
    expect(await (await list(plain.app, "ru")).json()).toEqual([]);
  });
});
