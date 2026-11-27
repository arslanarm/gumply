/**
 * v0.9 H (#snuin2ja): one registry of user actions. The Cmd+K palette lists
 * them, the sidebar ⋯ menu builds its rows from the page commands here, and
 * the desktop's native menu sends these ids. So a label, a condition or a
 * handler can't drift between them.
 *
 * A command is data: an id, a group, an icon, its label and search words
 * (en and ru through `t()`), an optional shortcut hint, and `when` (does it
 * apply here?). What it does lives in App, as one handler per id
 * (`CommandHandlers`): a command without a handler doesn't typecheck.
 *
 * Families that mirror another list (Insert = the `/` menu, Turn into, the
 * board tools) are built from that list, so they grow with it.
 */
import { isDesktopApp } from "./desktop-app.js";
import type { PageMeta } from "@gumply/core";
import { t, tEnglish, type MessageKey } from "../i18n/index.js";
import type { IconName } from "../components/Icon.js";
import { isBase } from "./bases.js";
import { isBoard } from "./boards.js";
import { SHORTCUT_KEYS, type ShortcutId } from "./shortcuts.js";
import {
  wantsConflicts,
  wantsExportHtml,
  wantsExportPdf,
  wantsHistory,
  wantsImportNotion,
  wantsLanguage,
  wantsOutline,
  wantsPageTemplate,
  wantsTemplate,
  wantsToday,
} from "./search.js";

export type CommandGroup = "page" | "new" | "editor" | "board" | "views" | "settings" | "help";

/** The order of the groups in `>` mode. */
export const COMMAND_GROUPS: readonly CommandGroup[] = ["page", "new", "editor", "board", "views", "settings", "help"];

/** Where the palette was opened: decides which commands apply. */
export interface CommandContext {
  /** The open page, board or base (or a sidebar row's page, for the ⋯ menu); null in a view. */
  page: PageMeta | null;
  /** A note's editor is mounted (Insert / Turn into apply). */
  editor: boolean;
  /** A board's editor is ready (tools, fit, zoom). */
  board: boolean;
  /** The desktop app (Updates…). */
  desktop: boolean;
}

/** Kinds of the target page, as the ⋯ menu has always read them. */
const kind = (page: PageMeta | null) => {
  if (!page) return null;
  const board = isBoard(page);
  const base = isBase(page);
  const folder = page.kind === "folder";
  return { board, base, folder, leaf: board || base, note: !board && !base && !folder };
};

interface StaticCommand {
  group: CommandGroup;
  icon: IconName;
  /** The palette's label. */
  label: MessageKey;
  /** Extra search words, space-separated (empty in en when the label says it all). */
  words?: MessageKey;
  /** English words that always count, whatever the interface language. */
  en?: string;
  shortcut?: ShortcutId;
  /** Kept from the commands Cmd+K had before (existing tests and muscle memory). */
  testId?: string;
  when?: (context: CommandContext) => boolean;
  /** Runs from a menu, but isn't listed in Cmd+K (Search pages: Cmd+K is already open). */
  hidden?: true;
}

/**
 * The page commands, shared by the palette and the sidebar ⋯ menu (in menu
 * order). `menuLabel` is the ⋯ row's label; `when` reads the target page.
 */
const PAGE_COMMANDS = {
  "page.rename": { group: "page", icon: "pencil", label: "commands.page.rename", en: "rename title", when: (c) => c.page !== null },
  "page.duplicate": { group: "page", icon: "copy", label: "commands.page.duplicate", en: "duplicate copy clone", when: (c) => !!kind(c.page) && !kind(c.page)!.folder },
  "page.copy-link": { group: "page", icon: "link", label: "commands.page.copyLink", en: "copy link wikilink", when: (c) => !!kind(c.page) && !kind(c.page)!.folder },
  "page.move": { group: "page", icon: "move", label: "commands.page.move", en: "move to folder parent", when: (c) => c.page !== null },
  // #vhdp68sm (N8): the desktop app only (a browser would open a tab). `c.desktop` is set where the
  // palette knows it (it's narrower: an install that can update); isDesktopApp() covers every desktop run.
  "page.open-window": { group: "page", icon: "externalLink", label: "commands.page.openWindow", en: "open in new window window", when: (c) => (c.desktop || isDesktopApp()) && !!kind(c.page) && !kind(c.page)!.folder },
  // #ifcn6pvx: the row's + as a menu item, so the keyboard reaches it from the row.
  "page.add-page": { group: "page", icon: "plus", label: "commands.page.addPage", en: "add page inside new sub page child", when: (c) => !!kind(c.page) && !kind(c.page)!.leaf },
  "page.add-board": { group: "page", icon: "board", label: "commands.page.addBoard", en: "add whiteboard board inside", when: (c) => !!kind(c.page) && !kind(c.page)!.leaf },
  "page.add-base": { group: "page", icon: "database", label: "commands.page.addBase", en: "add database view base inside", when: (c) => !!kind(c.page) && !kind(c.page)!.leaf },
  "page.new-from-template": { group: "page", icon: "pageTemplate", label: "commands.page.newFromTemplate", en: "new page from template inside", when: (c) => !!kind(c.page) && !kind(c.page)!.board },
  "page.import-notion": { group: "new", icon: "folderOpen", label: "notionImport.command", words: "search.importWords", en: "import from notion", testId: "search-import-notion", when: (c) => !kind(c.page)?.leaf },
  "page.export-html": { group: "page", icon: "download", label: "export.command", words: "search.exportWords", en: "export as html page save", testId: "search-export-html", when: (c) => !!kind(c.page)?.note },
  "page.export-pdf": { group: "page", icon: "file", label: "export.pdf.command", words: "search.pdfWords", en: "export as pdf print page", testId: "search-export-pdf", when: (c) => !!kind(c.page)?.note },
  // #pypzxe6i: a board's own export (its canvas has no ⋯ any more): a dialog with the format and options.
  "page.export-board": { group: "page", icon: "download", label: "board.export.command", en: "export board as image png svg picture save", when: (c) => !!kind(c.page)?.board },
  "page.history": { group: "page", icon: "clock", label: "history.command", words: "search.historyWords", en: "history page history show page history version history versions restore version", testId: "search-history", when: (c) => !!kind(c.page) && !kind(c.page)!.folder },
  // #7prbquxu phase 4: a database that owns its rows folder shows or hides it in the sidebar.
  "page.show-rows": { group: "page", icon: "sidebar", label: "commands.page.toggleRows", en: "show hide rows in the sidebar database folder", when: (c) => c.page?.kind === "base" && !!c.page.rowsFolder },
  "page.delete": { group: "page", icon: "trash", label: "commands.page.delete", en: "delete remove trash", when: (c) => c.page !== null },
} satisfies Record<string, StaticCommand>;

export type PageCommandId = keyof typeof PAGE_COMMANDS;

/** The ⋯ menu: groups of page commands, separated by a line (#sjts42ue). */
export const ROW_MENU: readonly (readonly PageCommandId[])[] = [
  ["page.rename", "page.duplicate", "page.copy-link", "page.move", "page.open-window", "page.show-rows"],
  ["page.add-page", "page.add-board", "page.add-base", "page.new-from-template"],
  ["page.import-notion", "page.export-html", "page.export-pdf", "page.export-board", "page.history"],
  ["page.delete"],
];

/** The ⋯ row's label for a page command on `page` (shorter than the palette's). */
export function menuLabel(id: PageCommandId, page: PageMeta): string {
  switch (id) {
    case "page.rename":
      return t("sidebar.rename");
    case "page.duplicate":
      return t("sidebar.duplicate");
    case "page.copy-link":
      return t("sidebar.copyLink");
    case "page.move":
      return t("sidebar.moveTo");
    case "page.open-window":
      return t("sidebar.openInNewWindow");
    case "page.add-page":
      return page.kind === "folder" ? t("sidebar.newPageInside") : t("sidebar.newSubPage");
    case "page.add-board":
      return t("sidebar.addBoardInside");
    case "page.add-base":
      return t("bases.addBaseInside");
    case "page.show-rows":
      return page.showRows ? t("bases.hideRowsInSidebar") : t("bases.showRowsInSidebar");
    case "page.new-from-template":
      return t("sidebar.newFromTemplate");
    case "page.import-notion":
      return t("notionImport.menuItem");
    case "page.export-html":
      return t("export.menuItem");
    case "page.export-pdf":
      return t("export.pdf.menuItem");
    case "page.export-board":
      return t("board.export.menuItem");
    case "page.history":
      return t("history.menuItem");
    case "page.delete": {
      const k = kind(page)!;
      // #959nz9nr: a database that owns its rows is deleted as a database (with them, by default), not as a view.
      if (k.base && page.rowsFolder) return t("bases.deleteDatabase");
      return k.board ? t("sidebar.deleteBoard") : k.base ? t("bases.deleteBase") : k.folder ? t("sidebar.deleteFolder") : t("sidebar.deletePage");
    }
  }
}

/** The ⋯ row's test id prefix (`<prefix>-<pageId>`), as it has always been. */
export const ROW_TEST_IDS: Record<PageCommandId, string> = {
  "page.rename": "rename-page",
  "page.duplicate": "duplicate-page",
  "page.copy-link": "copy-link",
  "page.move": "move-page",
  "page.open-window": "open-window",
  "page.add-page": "add-page",
  "page.add-board": "add-board",
  "page.add-base": "add-base",
  "page.new-from-template": "new-from-template",
  "page.import-notion": "import-notion",
  "page.export-html": "export-html",
  "page.export-pdf": "export-pdf",
  "page.export-board": "export-board",
  "page.history": "page-history",
  "page.show-rows": "toggle-rows",
  "page.delete": "delete-page",
};

const onPage = (c: CommandContext) => c.page !== null;

const OTHER_COMMANDS = {
  // New
  "new.page": { group: "new", icon: "plus", label: "commands.new.page", en: "new page create note" },
  "new.board": { group: "new", icon: "board", label: "commands.new.board", en: "new whiteboard board canvas" },
  "new.database": { group: "new", icon: "database", label: "commands.new.database", en: "new database table spreadsheet rows" },
  "new.base": { group: "new", icon: "database", label: "commands.new.base", en: "new view of pages database view base table query" },
  "new.page-from-template": { group: "new", icon: "pageTemplate", label: "search.pageTemplate", words: "search.pageTemplateWords", en: "new page from template templates", testId: "search-page-template" },
  "new.board-from-template": { group: "new", icon: "board", label: "search.fromTemplate", words: "search.templateWords", en: "new board from template whiteboard kanban mind map retrospective retro flowchart weekly plan", testId: "search-from-template" },
  "new.today": { group: "new", icon: "calendar", label: "search.today", words: "search.todayWords", en: "today daily daily note journal", shortcut: "openToday", testId: "search-today" },
  // Views
  "view.outline": { group: "views", icon: "list", label: "outline.toggle", words: "search.outlineWords", en: "outline toggle outline table of contents contents headings", shortcut: "toggleOutline", testId: "search-outline", when: onPage },
  "view.local-graph": { group: "views", icon: "graph", label: "commands.view.localGraph", en: "local graph links connections", when: onPage },
  "view.search": { group: "views", icon: "search", label: "commands.view.search", en: "search find pages quick switcher", shortcut: "searchPages", hidden: true },
  "view.graph": { group: "views", icon: "graph", label: "commands.view.graph", en: "graph view all pages links" },
  "view.trash": { group: "views", icon: "trash", label: "commands.view.trash", en: "trash deleted bin restore" },
  "view.conflicts": { group: "views", icon: "alert", label: "conflicts.command", words: "conflicts.commandWords", en: "conflicts show conflicts sync conflicts conflicted copy", testId: "search-conflicts" },
  "view.tags": { group: "views", icon: "tag", label: "commands.view.tags", en: "tags tag pane hashtags" },
  "view.sidebar": { group: "views", icon: "sidebar", label: "commands.view.sidebar", en: "toggle sidebar hide show", shortcut: "toggleSidebar" },
  // Settings
  "settings.theme-system": { group: "settings", icon: "monitor", label: "commands.settings.themeSystem", en: "theme system auto appearance" },
  "settings.theme-light": { group: "settings", icon: "sun", label: "commands.settings.themeLight", en: "theme light appearance" },
  "settings.theme-dark": { group: "settings", icon: "moon", label: "commands.settings.themeDark", en: "theme dark night appearance" },
  "settings.font-default": { group: "settings", icon: "text", label: "commands.settings.fontDefault", en: "font default sans typeface" },
  "settings.font-serif": { group: "settings", icon: "text", label: "commands.settings.fontSerif", en: "font serif typeface" },
  "settings.font-mono": { group: "settings", icon: "text", label: "commands.settings.fontMono", en: "font mono monospace typeface" },
  "settings.width-normal": { group: "settings", icon: "file", label: "commands.settings.widthNormal", en: "page width normal narrow" },
  "settings.width-wide": { group: "settings", icon: "file", label: "commands.settings.widthWide", en: "page width wide" },
  "settings.width-full": { group: "settings", icon: "file", label: "commands.settings.widthFull", en: "page width full" },
  "settings.language": { group: "settings", icon: "languages", label: "settings.languageCommand", words: "search.languageWords", en: "language languages settings lang", testId: "search-language" },
  "settings.ai-apps": { group: "settings", icon: "brand", label: "commands.settings.aiApps", en: "ai apps mcp claude assistant" },
  "settings.version-history": { group: "settings", icon: "clock", label: "commands.settings.versionHistory", en: "version history settings storage clear" },
  "settings.updates": { group: "settings", icon: "download", label: "commands.settings.updates", en: "updates check update version", when: (c) => c.desktop },
  "settings.open": { group: "settings", icon: "settings", label: "commands.settings.open", en: "settings preferences options" },
  // Board
  "board.fit": { group: "board", icon: "monitor", label: "commands.board.fit", en: "fit zoom to fit screen board", shortcut: "boardFit", when: (c) => c.board },
  "board.zoom-in": { group: "board", icon: "plus", label: "commands.board.zoomIn", en: "zoom in board", when: (c) => c.board },
  "board.zoom-out": { group: "board", icon: "minus", label: "commands.board.zoomOut", en: "zoom out board", when: (c) => c.board },
  "board.zoom-reset": { group: "board", icon: "search", label: "commands.board.zoomReset", en: "zoom 100% actual size reset board", when: (c) => c.board },
  // Help
  "help.shortcuts": { group: "help", icon: "keyboard", label: "commands.help.shortcuts", en: "keyboard shortcuts keys help", shortcut: "shortcuts" },
  "help.guide": { group: "help", icon: "help", label: "commands.help.guide", en: "user guide help manual docs documentation" },
} satisfies Record<string, StaticCommand>;

const STATIC_COMMANDS: Record<StaticCommandId, StaticCommand> = { ...PAGE_COMMANDS, ...OTHER_COMMANDS };

export type StaticCommandId = PageCommandId | keyof typeof OTHER_COMMANDS;
export const STATIC_COMMAND_IDS = Object.keys(STATIC_COMMANDS) as StaticCommandId[];

/** What App does for each command: one handler per id, so none can be missing. */
export type CommandHandlers = Record<StaticCommandId, () => void>;

/** Whether a command applies in `context` (the ⋯ menu asks this for each row). */
export function commandApplies(id: StaticCommandId, context: CommandContext): boolean {
  const when = STATIC_COMMANDS[id].when;
  return !when || when(context);
}

/** The board tools, as the board's toolbar lists them (keys are the toolbar's). */
export type BoardToolId = "select" | "hand" | "sticky" | "text" | "shape" | "connector" | "frame" | "pen";
export const BOARD_TOOLS: readonly { tool: BoardToolId; keys: string }[] = [
  { tool: "select", keys: "V" },
  { tool: "hand", keys: "H" },
  { tool: "sticky", keys: "N" },
  { tool: "text", keys: "T" },
  { tool: "shape", keys: "S" },
  { tool: "connector", keys: "C" },
  { tool: "frame", keys: "F" },
  { tool: "pen", keys: "P" },
];

/** A `/` menu item or a Turn into choice, as the palette needs them. */
export interface EditorEntry {
  key: string;
  readonly label: string;
  readonly keywords?: readonly string[];
}

/** One row the palette can show. */
export interface Command {
  id: string;
  group: CommandGroup;
  icon: IconName;
  label: string;
  /** Lower-case words a query is matched against (label, en label, words in both languages). */
  words: string[];
  /** Keys to show on the right, e.g. ["Ctrl", "Shift", "D"]. */
  keys?: readonly string[];
  testId: string;
}

const split = (text: string) => text.toLowerCase().split(/[\s,:/·.…()“”"«»]+/).filter(Boolean);

function staticCommand(id: StaticCommandId, modifier: string): Command {
  const spec = STATIC_COMMANDS[id];
  const label = t(spec.label);
  const words = [...split(label), ...split(tEnglish(spec.label)), ...split(spec.en ?? ""), ...(spec.words ? split(t(spec.words)) : [])];
  return {
    id,
    group: spec.group,
    icon: spec.icon,
    label,
    words: [...new Set(words)],
    keys: spec.shortcut ? shortcutKeys(spec.shortcut, modifier) : undefined,
    testId: spec.testId ?? `command-${id}`,
  };
}

/** A shortcut's keys for display: "Mod" becomes ⌘ or Ctrl. */
export function shortcutKeys(id: ShortcutId, modifier: string): string[] {
  return SHORTCUT_KEYS[id].map((key) => (key === "Mod" ? modifier : key));
}

/** Every command that applies in `context`, in group order. */
export function availableCommands(
  context: CommandContext,
  families: { modifier: string; insert?: readonly EditorEntry[]; turnInto?: readonly EditorEntry[]; boardTools?: readonly EditorEntry[] },
): Command[] {
  const out: Command[] = [];
  for (const id of STATIC_COMMAND_IDS) {
    const spec = STATIC_COMMANDS[id];
    if (spec.hidden || (spec.when && !spec.when(context))) continue;
    out.push(staticCommand(id, families.modifier));
  }
  if (context.editor) {
    for (const item of families.insert ?? []) {
      out.push({
        id: `editor.insert.${item.key}`,
        group: "editor",
        icon: "plus",
        label: t("commands.editor.insert", { block: item.label }),
        words: [...new Set([...split(t("commands.editor.insertWord")), "insert", "add", ...split(item.label), ...(item.keywords ?? []).flatMap(split)])],
        testId: `command-editor.insert.${item.key}`,
      });
    }
    for (const item of families.turnInto ?? []) {
      out.push({
        id: `editor.turn-into.${item.key}`,
        group: "editor",
        icon: "shuffle",
        label: t("commands.editor.turnInto", { block: item.label }),
        words: [...new Set([...split(t("commands.editor.turnIntoWords")), "turn", "into", "convert", "change", ...split(item.label)])],
        testId: `command-editor.turn-into.${item.key}`,
      });
    }
  }
  if (context.board) {
    for (const item of families.boardTools ?? []) {
      const keys = BOARD_TOOLS.find((tool) => tool.tool === item.key)?.keys;
      out.push({
        id: `board.tool.${item.key}`,
        group: "board",
        icon: "board",
        label: t("commands.board.tool", { tool: item.label }),
        words: [...new Set([...split(t("commands.board.toolWords")), "tool", "board", ...split(item.label), item.key])],
        keys: keys ? [keys] : undefined,
        testId: `command-board.tool.${item.key}`,
      });
    }
  }
  const order = new Map(COMMAND_GROUPS.map((group, index) => [group, index]));
  return out.sort((a, b) => order.get(a.group)! - order.get(b.group)!);
}

/**
 * Commands matching `query`, best first: every query word must start a word
 * of the command. A match on the label's own words ranks above one on extra
 * words; ties keep the registry order.
 */
export function matchCommands(commands: readonly Command[], query: string): Command[] {
  const words = split(query);
  if (words.length === 0) return [...commands];
  const scored: Array<{ command: Command; score: number; index: number }> = [];
  commands.forEach((command, index) => {
    if (!words.every((word) => command.words.some((candidate) => candidate.startsWith(word)))) return;
    const label = split(command.label);
    const onLabel = words.filter((word) => label.some((candidate) => candidate.startsWith(word))).length;
    const starts = label[0]?.startsWith(words[0]!) ? 1 : 0;
    scored.push({ command, score: onLabel * 2 + starts, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.command);
}

/** How many commands plain typing shows after the pages (`>` shows them all). */
export const PLAIN_COMMAND_LIMIT = 5;

/**
 * The commands Cmd+K had before the registry keep their own, tested matching
 * in plain typing (`templ` → New page from template…; `to` isn't Today yet).
 */
const PLAIN_MATCHERS: Partial<Record<string, (query: string) => boolean>> = {
  "new.page-from-template": wantsPageTemplate,
  "new.board-from-template": wantsTemplate,
  "new.today": wantsToday,
  "page.export-html": wantsExportHtml,
  "page.export-pdf": wantsExportPdf,
  "page.import-notion": wantsImportNotion,
  "page.history": wantsHistory,
  "view.outline": wantsOutline,
  "view.conflicts": wantsConflicts,
  "settings.language": wantsLanguage,
};

/**
 * Commands for plain typing, after the pages: those that ask for 3+
 * characters and match every word, best first, at most PLAIN_COMMAND_LIMIT.
 * A `#tag` query is never a command, and the editor's Insert / Turn into
 * rows only show in `>` mode.
 */
export function plainCommandMatches(commands: readonly Command[], query: string): Command[] {
  const needle = query.trim();
  if (needle.length < 3 || needle.startsWith("#")) return [];
  const legacy = commands.filter((command) => PLAIN_MATCHERS[command.id]?.(needle));
  // Insert / Turn into stay in `>` mode: plain typing is page search first.
  const generic = matchCommands(
    commands.filter((command) => !PLAIN_MATCHERS[command.id] && command.group !== "editor"),
    needle,
  );
  return [...legacy, ...generic].slice(0, PLAIN_COMMAND_LIMIT);
}

/** A query in commands mode (`>` first): the rest of it, else null. */
export function commandQuery(query: string): string | null {
  const trimmed = query.trimStart();
  return trimmed.startsWith(">") ? trimmed.slice(1).trim() : null;
}

/** The desktop menu's older ids (before #snuin2ja), still accepted from an older shell. */
export const LEGACY_DESKTOP_IDS: Record<string, StaticCommandId> = {
  "new-page": "new.page",
  "new-whiteboard": "new.board",
  "import-notion": "page.import-notion",
  "export-pdf": "page.export-pdf",
  search: "view.search",
};

export function isStaticCommandId(id: string): id is StaticCommandId {
  return Object.prototype.hasOwnProperty.call(STATIC_COMMANDS, id);
}

/** The group's heading in `>` mode. */
export function groupLabel(group: CommandGroup, page: PageMeta | null): string {
  if (group === "page" && page) return t("commands.groups.pageNamed", { title: page.title });
  return t(`commands.groups.${group}`);
}
