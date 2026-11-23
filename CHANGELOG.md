# Changelog

What changed in each Gumply release, newest first. Installers and full release notes are on [GitHub Releases](https://github.com/arslanarm/gumply/releases) (from 0.5.0 on).

## 0.8.2: a safer save (2026-11-23)

A fix release, recommended for everyone on 0.8.

**Fixed**
- **A save could be lost when two programs saved the same note, board or database view at the same moment**, for example an AI app connected to Gumply, Obsidian or a sync tool saving in the same instant as Gumply. Gumply now always notices that the file changed in the meantime and never writes over it: the app offers **Reload** or **Keep mine** (with a backup), and an AI app is told and reads the page again.

## 0.8.1: AI apps on Windows (2026-11-22)

**Fixed**
- **Windows:** Claude Desktop and other AI apps can connect to Gumply. Before, `Gumply.exe --mcp` never answered and never exited.
- AI apps see Gumply's real version.
- Notion import: database board views are written in the order Obsidian uses, so Obsidian doesn't rewrite them when it opens them.
- Clearer AI-app messages and docs ("Settings → AI apps"; the AppImage needs no extra setting).

## 0.8.0: connect and move in (2026-11-22)

**New**
- **AI apps (MCP):** a built-in server lets Claude Code, Claude Desktop and other AI apps search, read and (if you allow it) write your notes. Read-only by default; every change goes into version history, can be undone, and is listed in Settings → AI apps, which gives you copy-paste setup snippets.
- **Import from Notion:** a Notion "Markdown & CSV" export becomes pages with their links, files and callouts; databases become pages with typed properties plus a table view (and a board where Notion had one), with a report of what was imported.
- **Export** a page as a self-contained HTML file or as PDF.
- **Links like Obsidian:** unlinked mentions with one-click linking; renaming a heading updates links to it; pages with the same name resolve from the linking note's folder; `[[Page#` lists headings; links in properties count in the graph and backlinks and follow renames; the `![[` menu offers any file in the vault.
- **Graph** filters and colour groups; an **outline** pane; **columns**; **math** (KaTeX) and **Mermaid** diagrams.
- Tags and aliases in any capitalisation, and a warning for tags Obsidian won't read.
- **Linux:** the AppImage no longer needs `libfuse2`, and the `.deb` keeps Chromium's sandbox.

**Improved**
- Files stay exactly as written in more cases: tabs, lazy quotes, nested quotes and indented first lines.
- The page menu, the settings gear, Russian wording, accessible names and a licences window.

## 0.7.2: Markdown links stay as written (2026-11-22)

**Fixed**
- Saving a note no longer breaks Markdown links to files and notes in the vault (`[doc](Files/report.pdf)` used to become plain text). Titles, anchors, paths with spaces, reference-style links and linked images are kept exactly as written.
- Links the editor can't open (`obsidian://`, `zotero://`, empty ones) are kept as written and shown as text.
- Clicking a Markdown link to a note opens it in Gumply.
- **Safety:** `//host` links no longer open an outside site, and `javascript:`, `data:` and `vbscript:` links are never clickable.

## 0.7.1: escapes stay as written (2026-11-22)

**Fixed**
- Backslash escapes you didn't touch (`\*`, `\_`, `\#`, `\[`, `\$`, LaTeX spacing like `a\,b`) are kept exactly as written; a save used to strip them.
- Typed `*` and `_` are escaped only where they could turn into emphasis, so `snake_case` stays clean.

## 0.7.0: organise (2026-11-22)

**New**
- **Properties** under the page title (text, list, number, checkbox, date, date and time, tags, aliases), stored as frontmatter with Obsidian's types, with a date picker in your language.
- **Database views** as Obsidian Bases `.base` files: Table (sort, filter, group, edit in place), Kanban, Cards, List and Calendar; embeddable in pages.
- **Templates and daily notes**, compatible with Obsidian's settings.
- **Tags pane**, and renaming a tag everywhere.
- **Text and background colours**, and a **page cover** and **page background colour** (Banners plugin covers are shown and never rewritten).
- Obsidian image links resolve anywhere in the vault.
- **Russian** for the whole interface, desktop menus and demo vault, plus a guide to adding languages.

**Improved**
- A save never changes what you didn't edit: blank lines, line breaks, list markers and numbers, all heading levels, and properties Gumply would otherwise add.
- Narrow windows, sidebar titles, large folders, quitting with slow saves, and the first page of a vault.

## 0.6.0: Notion blocks and boards everywhere (2026-11-21)

**New**
- **Callouts and toggles**, with Obsidian's syntax and colours.
- **Whiteboards inside pages** (`![[Board.canvas]]`), live and resizable.
- **Trash:** search, restore (to the original place or the top level), delete forever, empty. Obsidian's own `.trash` files are never touched.
- **Board templates**, and **PNG and SVG export** of boards.
- **Selection toolbar and right-click menu** in the editor: bold, italic, highlight, links with page search, Turn into, block actions, Copy link to heading.
- **Plain folders:** Obsidian vaults keep their folder structure.
- Sidebar right-click menus, Duplicate, Copy link, tag chips; desktop settings survive relaunches.

**Fixed**
- Typing just before a reload, close or quit could be lost.
- A false "changed on disk" on plain notes.

## 0.5.0: the desktop app (2026-11-20)

**New**
- **Desktop app** for Linux (`.AppImage`, `.deb`), Windows (setup `.exe`) and macOS (`.dmg`/`.zip`, Apple silicon and Intel). It opens any folder of Markdown notes, including an Obsidian vault, remembers recent folders, and keeps everything as plain files. A new empty folder gets a short demo; a folder with files is opened untouched.
- **Safe by default:** the built-in server listens on your computer only, the window is sandboxed, and only documents open from the vault.

**Improved**
- Search finds phrases across formatting and links.
- Whiteboards: simpler drawing far zoomed out, handles that stay easy to hit, small cards that drag instead of resizing.
- Edits made in other apps right after a Gumply save are always picked up.

## 0.4.1: faster big boards (2026-11-20)

- Zooming big boards no longer stalls, and big selections move as one block.
- A label on a short arrow sits beside it instead of covering it.
- Clearer upload error messages.

## 0.4.0: whiteboards (2026-11-20)

**New**
- **Whiteboards in the page tree**, like Miro: stickies, text, shapes, frames, a pen, images and files; connectors with labels; Markdown and `[[links]]` in stickies; live page cards dragged from the sidebar; copy/paste, colours, undo and redo.
- Boards appear in the graph, "Linked from" and search, and follow page renames.
- **Plain files:** each board is a `.canvas` file in Obsidian's open JSON Canvas format; boards open in Obsidian and Obsidian's boards open in Gumply. Edits made outside are never silently lost.

**Improved**
- The web app works on any port; the graph no longer snaps back while fitting; a calm "Reload" message after an update.

## 0.3.0: Notion blocks and speed (2026-11-20)

**New**
- **Editable tables**, like Notion, still saved as plain Markdown tables.
- **Code blocks** with a language picker, highlighting and a Copy button.
- Images inside a line of text stay inline; web images can be saved into the vault.

**Improved**
- About 30% less to download, and pages show sooner in big vaults.
- **Security:** the local server listens on your computer only, and other websites can't read or change your notes.

## 0.2.0: quality pass (2026-11-20)

**Improved**
- **Notion-style blocks:** a hover gutter with **+** and **⋮⋮** (drag, turn into, duplicate, delete), and Notion typography.
- Empty lines are kept; emoji suggestions and picker; images and files by paste, drop or `/image`; pasted tables become tables.
- **Your files:** notes are preserved byte for byte when edited; file names follow page titles; links work in Obsidian; image links are relative to the note; edits made outside Gumply are never overwritten.
- **Graph:** always fitted, Obsidian's look, fast at 1,000 pages.
- Collapsible sidebar, phone-width layout, a welcome page on first run.

## 0.1.0: first release (2026-11-20)

Nested pages, a block editor with a `/` menu, `[[wikilinks]]` with "Linked from" and links updated on rename, a global and local graph, Cmd/Ctrl+K search, dark mode, a first-run demo and a `?` shortcuts overlay. Notes are plain Markdown files in a folder.
