import { readFileSync } from "node:fs";
import type { PageMeta } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";
import { flattenMessages, setLanguage } from "../src/i18n/index.js";
import {
  availableCommands,
  commandQuery,
  isStaticCommandId,
  LEGACY_DESKTOP_IDS,
  matchCommands,
  menuLabel,
  plainCommandMatches,
  ROW_MENU,
  ROW_TEST_IDS,
  STATIC_COMMAND_IDS,
  type CommandContext,
  type CommandHandlers,
} from "../src/lib/commands.js";

/** v0.9 H (#snuin2ja): one registry for the palette, the ⋯ menu and the desktop menu. */

const meta = (id: string, kind: PageMeta["kind"] = "page"): PageMeta => ({ id, title: id, kind }) as PageMeta;
const context = (page: PageMeta | null, extra: Partial<CommandContext> = {}): CommandContext => ({ page, editor: false, board: false, desktop: false, ...extra });
const ids = (ctx: CommandContext, families = {}) => availableCommands(ctx, { modifier: "Ctrl", ...families }).map((command) => command.id);

const enMessages = flattenMessages(en);
const ruMessages = flattenMessages(ru);

afterEach(async () => {
  await setLanguage("en");
});

describe("the registry", () => {
  it("every command has a label in en and ru", async () => {
    for (const language of ["en", "ru"] as const) {
      await setLanguage(language);
      // #7prbquxu phase 4: "Show rows in the sidebar" applies only to a database that owns its rows folder.
      const owned = { ...meta("People.base", "base"), rowsFolder: "People" } as PageMeta;
      const all = [
        ...availableCommands(context(meta("P"), { editor: true, board: true, desktop: true }), { modifier: "Ctrl" }),
        ...availableCommands(context(owned), { modifier: "Ctrl" }),
        // #pypzxe6i: a board's own commands (Export as image…).
        ...availableCommands(context(meta("Map.canvas", "whiteboard")), { modifier: "Ctrl" }),
      ];
      for (const id of STATIC_COMMAND_IDS.filter((item) => item !== "view.search")) {
        const command = all.find((item) => item.id === id);
        expect(command, `${id} applies somewhere`).toBeDefined();
        expect(command!.label.length, id).toBeGreaterThan(0);
        expect(command!.label, `${id} is translated`).not.toMatch(/^[a-z]+\.[a-zA-Z.]+$/);
      }
    }
    for (const key of enMessages.keys()) {
      if (key.startsWith("commands.") && enMessages.get(key) !== "") expect(ruMessages.get(key), key).toBeTruthy();
    }
  });

  it("every command has a handler (CommandHandlers is keyed by every id)", () => {
    // A handler map built from the ids alone covers all of them; App's literal object is typed CommandHandlers.
    const handlers = Object.fromEntries(STATIC_COMMAND_IDS.map((id) => [id, () => id])) as unknown as CommandHandlers;
    expect(Object.keys(handlers).sort()).toEqual([...STATIC_COMMAND_IDS].sort());
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/: CommandHandlers = \{/);
  });

  it("the ⋯ menu is built from the registry: every row is a page command, none hard-coded", () => {
    for (const id of ROW_MENU.flat()) {
      expect(isStaticCommandId(id)).toBe(true);
      expect(ROW_TEST_IDS[id]).toBeTruthy();
      expect(menuLabel(id, meta("P")).length).toBeGreaterThan(0);
    }
    const item = readFileSync(new URL("../src/components/PageItem.tsx", import.meta.url), "utf8");
    // Only the registry's rows: no menu item made from a literal test id.
    expect(item).toContain("ROW_MENU");
    expect(item).not.toMatch(/menuItem\(\s*"/);
  });

  it("the desktop menu's ids are commands (older ids too)", () => {
    const main = readFileSync(new URL("../../desktop/src/main.ts", import.meta.url), "utf8");
    const sent = [...main.matchAll(/sendCommand\("([^"]+)"\)/g)].map((match) => match[1]!);
    expect(sent.length).toBeGreaterThan(0);
    for (const id of sent) expect(isStaticCommandId(id), id).toBe(true);
    for (const id of Object.values(LEGACY_DESKTOP_IDS)) expect(isStaticCommandId(id)).toBe(true);
  });
});

describe("context", () => {
  it("page commands only when a page is open, and as the ⋯ menu offers them", () => {
    const none = ids(context(null));
    expect(none.some((id) => id.startsWith("page.") && id !== "page.import-notion")).toBe(false);
    expect(none).toContain("new.page");
    expect(none).toContain("view.graph");
    expect(none).not.toContain("view.outline");

    const note = ids(context(meta("Note")));
    expect(note).toEqual(expect.arrayContaining(["page.export-html", "page.export-pdf", "page.history", "page.duplicate", "page.delete"]));

    const board = ids(context(meta("Map.canvas", "whiteboard")));
    expect(board).toContain("page.history");
    expect(board).not.toContain("page.export-html");
    // #pypzxe6i: a board's own export, and only a board's.
    expect(board).toContain("page.export-board");
    expect(note).not.toContain("page.export-board");
    expect(board).not.toContain("page.add-board");
    expect(board).not.toContain("page.new-from-template");

    const base = ids(context(meta("Tasks.base", "base")));
    // N1 (#kw8th869): database views have version history too.
    expect(base).toContain("page.history");

    const folder = ids(context(meta("Folder", "folder")));
    expect(folder).not.toContain("page.duplicate");
    expect(folder).not.toContain("page.copy-link");
    expect(folder).toContain("page.move");
  });

  it("editor and board families only where they apply; Updates only on the desktop", () => {
    const families = { insert: [{ key: "heading-1", label: "Heading 1" }], turnInto: [{ key: "h1", label: "Heading 1" }], boardTools: [{ key: "pen", label: "Pen" }] };
    expect(ids(context(meta("P")), families).some((id) => id.startsWith("editor.") || id.startsWith("board."))).toBe(false);
    expect(ids(context(meta("P"), { editor: true }), families)).toEqual(expect.arrayContaining(["editor.insert.heading-1", "editor.turn-into.h1"]));
    expect(ids(context(meta("B.canvas", "whiteboard"), { board: true }), families)).toEqual(expect.arrayContaining(["board.tool.pen", "board.fit", "board.zoom-in"]));
    expect(ids(context(null))).not.toContain("settings.updates");
    expect(ids(context(null, { desktop: true }))).toContain("settings.updates");
  });

  it("groups come in a fixed order", () => {
    const groups = availableCommands(context(meta("P"), { editor: true, board: true }), { modifier: "Ctrl", insert: [{ key: "x", label: "X" }] }).map((command) => command.group);
    const order = ["page", "new", "editor", "board", "views", "settings", "help"];
    expect(groups.map((group) => order.indexOf(group))).toEqual([...groups.map((group) => order.indexOf(group))].sort((a, b) => a - b));
  });
});

describe("matching", () => {
  const all = () => availableCommands(context(meta("P"), { editor: true }), { modifier: "Ctrl", insert: [{ key: "heading-1", label: "Heading 1", keywords: ["h1", "title"] }] });

  it("every word must start a word of the command; label matches rank first", () => {
    expect(matchCommands(all(), "export").map((command) => command.id).slice(0, 2).sort()).toEqual(["page.export-html", "page.export-pdf"]);
    expect(matchCommands(all(), "exp pdf")[0]!.id).toBe("page.export-pdf");
    expect(matchCommands(all(), "hist")[0]!.id).toBe("page.history");
    expect(matchCommands(all(), "theme dark")[0]!.id).toBe("settings.theme-dark");
    expect(matchCommands(all(), "insert h1")[0]!.id).toBe("editor.insert.heading-1");
    expect(matchCommands(all(), "zzzz")).toEqual([]);
  });

  it("ru: Russian and English words both match", async () => {
    await setLanguage("ru");
    expect(matchCommands(all(), "тема тёмн")[0]!.id).toBe("settings.theme-dark");
    expect(matchCommands(all(), "theme dark")[0]!.id).toBe("settings.theme-dark");
    expect(matchCommands(all(), "экспорт").map((command) => command.id)).toEqual(expect.arrayContaining(["page.export-html", "page.export-pdf"]));
    expect(matchCommands(all(), "export").map((command) => command.id)).toEqual(expect.arrayContaining(["page.export-html", "page.export-pdf"]));
  });

  it("plain typing: never Insert / Turn into (those are `>` only), at most 5, 3+ characters, no #tags", () => {
    const families = { modifier: "Ctrl", insert: [{ key: "table", label: "Table", keywords: ["grid"] }], turnInto: [{ key: "h1", label: "Heading 1" }] };
    const commands = availableCommands(context(meta("P"), { editor: true }), families);
    expect(matchCommands(commands, "table").map((command) => command.id)).toContain("editor.insert.table");
    expect(plainCommandMatches(commands, "table").map((command) => command.id)).not.toContain("editor.insert.table");
    expect(plainCommandMatches(commands, "turn into").some((command) => command.group === "editor")).toBe(false);
    expect(plainCommandMatches(commands, "page").length).toBeLessThanOrEqual(5);
    expect(plainCommandMatches(commands, "th")).toEqual([]);
    expect(plainCommandMatches(commands, "#theme")).toEqual([]);
    expect(plainCommandMatches(commands, "theme dark")[0]!.id).toBe("settings.theme-dark");
  });

  it("> starts commands mode", () => {
    expect(commandQuery(">")).toBe("");
    expect(commandQuery("  > theme ")).toBe("theme");
    expect(commandQuery("theme")).toBeNull();
  });

  it("shortcut hints come from the shared keys", () => {
    const today = availableCommands(context(null), { modifier: "⌘" }).find((command) => command.id === "new.today")!;
    expect(today.keys).toEqual(["⌘", "Shift", "D"]);
  });
});
