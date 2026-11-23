# Gumply's file format (v1)

Your notes are plain files in a folder you choose (your *vault*). You can read and edit them without Gumply, back them up, sync them, or open them in another app. This page lists every file Gumply reads or writes in a vault, what it writes into each, and what it promises never to touch.

## The promises

- **Plain files you own.** Pages are Markdown, boards are JSON Canvas, database views are Obsidian Bases YAML.
- **A save never changes what you didn't touch.** Lines, properties, comments, list markers, line breaks and escapes you didn't edit stay exactly as they were.
- **Obsidian vaults open as they are.** Gumply reads Obsidian's formats; opening a vault in Gumply doesn't convert it.
- **Gumply's own data lives in hidden folders** (`.gumply/`, `.trash/`) and hidden temporary names, never inside your pages.

## Your files

### What appears in the sidebar

- `*.md` files are pages, `*.canvas` files are boards, `*.base` files are database views, and folders are folders.
- **Hidden from the sidebar:** anything whose name starts with a dot (`.gumply/`, `.trash/`, `.obsidian/`, `.git/`…), `node_modules`, the `attachments/` folder at the top of the vault, and symbolic links.
- **Sub-pages:** the page `Plan` is `Plan.md`, and its sub-pages live in the folder `Plan/` next to it. A folder without a page of the same name next to it is shown as a plain folder; looking at it never writes anything.

### File names

- A page's file name is its title. These characters can't be in a file name and become spaces: `\ / : * ? " < > | # ^ [ ]`. Spaces are collapsed, leading dots and trailing dots or spaces are removed, and names are kept under 120 characters. Upper and lower case are kept.
- Two pages with the same name in one folder become `Name`, `Name 2`, `Name 3`… (ignoring case).
- Renaming a page renames its file and its sub-page folder, and updates links to it in your other pages.

### Pages (`.md`)

**Text:** UTF-8. Gumply keeps your file's line endings (Windows or Unix), a byte-order mark if there is one, and whether the file ends with a newline.

**Properties (frontmatter):**

- Gumply's own keys are `title`, `icon`, `tags`, `created` and `updated` (dates like `2026-11-23T10:15:00.000Z`). A new page gets them.
- **Gumply never adds `created`, `updated` or `title` to a note that doesn't have them.** (`title` is the one exception, and only when the title can't be a file name, for example because it contains `/`.) A note without a properties block keeps none until you add a property, a tag or an icon.
- Your other keys are *properties*, with the same types as Obsidian (text, list, number, checkbox, date, date and time, tags, aliases).
- Changing one property rewrites only that property's lines. Comments, the order of keys, quotes and keys Gumply doesn't know stay as written.
- `aliases` is read and never written by Gumply.
- **Page look:**
  - `cover:` is an image in the vault (`"[[path/image.png]]"`), `color:<name>`, `gradient:<name>`, a web address, or `none`;
  - `cover-position:` is 0–100;
  - `background:` is a colour name (gray, red, orange, yellow, green, cyan, blue, purple, pink).
  - The Banners plugin's `banner`, `banner_y` and `banner_icon` are read and never changed.

**Text in a page.** Gumply reads and writes standard Markdown plus these forms. A block you didn't change is written back exactly as it was.

| What | In the file |
|---|---|
| Link to a page | `[[Page]]`, `[[Page\|shown text]]`, `[[Page#Heading]]`. When two pages share a name: `[[Folder/Page\|Page]]` |
| Link to a block | `[[Page#^a1b2c3]]`, with ` ^a1b2c3` written after the block it points to |
| Not a link | `\[[text]]` |
| Embedded page, section, board, view | `![[Page]]`, `![[Page#Heading]]`, `![[Board.canvas\|480]]` (height in pixels), `![[Tasks.base#View]]` |
| Image, file | `![pic](attachments/pic.png)`, `[report.pdf](attachments/report.pdf)`, relative to the page's own folder (`../attachments/pic.png` one level down); spaces written as `%20`. Obsidian's `![[pic.png]]` is read and kept |
| Callout | `> [!tip] Title` and `> text` lines |
| Toggle | `> [!note]- Title` (starts closed) or `> [!note]+ Title` (starts open) |
| Text colour | `<span style="color: var(--color-red);">text</span>` |
| Background colour | `<span style="background-color: rgba(var(--color-red-rgb), 0.2);">text</span>` |
| Highlight | `==text==` |
| Columns | `:::: {.columns}`, then each column as `::: {.column}` … `:::`, then `::::` |
| Math | `$x^2$` inline, or a `$$` … `$$` block |
| Diagram | a ```` ```mermaid ```` code block |
| To-do | `- [ ] task`, `- [x] done` |
| Table | a pipe table (`\| a \| b \|`) |
| Empty lines | each empty line you leave is one extra blank line; `&nbsp;` only where Markdown can't hold a blank line (the very top, between two lists) |

### Boards (`.canvas`)

- **The open JSON Canvas format** (Obsidian's canvas). Cards, files, links, frames and arrows are standard canvas objects.
- **Gumply's extras are extra keys** that other canvas apps keep:
  - `"gumply": {"kind": "sticky" | "text" | "shape" | "ink", …}` on a text card (a shape's `shape`, a drawing's `points`);
  - a top-level `"gumply"` with the board's `icon` and `tags`.
- A text card without a `gumply` key is shown as an ordinary Obsidian card.
- Keys Gumply doesn't know are kept. Moving one card rewrites only that card's numbers.

### Database views (`.base`)

- **Obsidian Bases YAML.** Table, cards, list and Kanban are Obsidian's own layouts. Calendar (`type: calendar` with `dateProperty`) is Gumply's; Obsidian keeps it but doesn't show it.
- Editing a view changes only that part of the YAML; comments and order stay.

### Images and files

- Saved in the vault's `attachments/` folder, under a cleaned-up name (`My photo.PNG` → `My-photo.png`; a clash gets `-1`, `-2`…), up to 25 MB each.
- Files from a Notion import go in `attachments/Notion import`.

## Gumply's own files

All of these are hidden, and none of them are your notes. When Gumply replaces one of these files (or one of your pages), it writes a temporary file first and then puts it in place, so a crash never leaves a half-written file. New files are created without overwriting anything, and logs are only ever added to.

| Path | What it is | Can you delete it? |
|---|---|---|
| `.gumply/history/<page>/` | Earlier versions of each page and board, as exact copies of the file, plus `index.jsonl` (when, who, why). Old versions are thinned automatically: all of the last day, one an hour for a week, one a day for 90 days (very large versions, over 5 MB: one a day, at most 10), within max(200 MB, half the vault). Versions you keep are never thinned. | Yes. You only lose the versions. |
| `.trash/<id>/` | Deleted pages, boards and folders, with `meta.json` (what was deleted, when). Restore moves them back. | Yes (or use Empty trash). |
| `.gumply/conflicts/` | When you choose **Keep mine**, the other program's version is kept here, byte for byte, named after the page (`Заметки-<time>.md`, `Map-<time>.canvas`). It's also in the page's history. | Yes. |
| `.gumply/mcp.json` | AI app access for this vault: `{"enabled": true, "access": "read"}` (`read`, `append` or `edit`). Missing means read-only. | Yes. AI apps go back to read-only. |
| `.gumply/mcp-log.jsonl` (+ `.1`, `.2`) | One line per change an AI app made: when, which tool, which page, the before and after versions, and which app. No note text. Rotated at 5 MB. | Yes. |
| `.gumply/types.json` | Property types, when the vault has no `.obsidian/` folder. | Yes. Types are guessed from values again. |
| `.gumply/graph.json` | Graph colour groups and filters. Saving keeps any settings Gumply doesn't know; a damaged file is moved aside as `graph.json.invalid-<time>`. | Yes. |
| `.gumply/sync-dismissed.json` | Pages you marked **Not a copy**. | Yes. They may be flagged again. |
| `.gumply/demo-seeded.json` | Remembers that the demo pages were added once. | Yes. |
| `.gumply/import/` | A Notion import while it's running. Removed when it ends. | Yes, when no import is running. |
| `.~gumply-….tmp` | A save in progress. Left over only if the app stopped mid-save; Gumply removes its own leftovers after a day, and never other programs' files. | Yes. |

Gumply never writes your sync tool's settings (such as `.stignore`). Settings → Version history shows the lines to add, so each device keeps its own history.

No window positions, recent vaults, font or startup page are stored in the vault: those are settings of the app on each computer.

## Obsidian's settings

- **Read:**
  - `.obsidian/templates.json` (templates folder, date and time formats);
  - `.obsidian/daily-notes.json` (daily notes folder, name format, template);
  - `.obsidian/graph.json` (colour groups, if Gumply has none of its own);
  - `.obsidian/types.json` (property types).
- **Written:** only `.obsidian/types.json`, and only when you change a property's type in a vault that already has `.obsidian/`. Just that one key is changed. Gumply never creates `.obsidian/`.
- **Templates** can use `{{title}}`, `{{date}}`, `{{time}}`, `{{date:YYYY-MM-DD}}` and `{{time:HH:mm}}`.

## Copies made by sync tools

These are recognised as conflicting copies:

| Tool | Name |
|---|---|
| Syncthing | `Note.sync-conflict-20261122-143005-ABCDEFG.md` |
| Nextcloud | `Note (conflicted copy 2026-11-22 143005).md`, `Note_conflict-20261122-143005.md` |
| Obsidian Sync | `Note (Conflicted copy Laptop 202611221430).md` |
| Dropbox | `Note (Anna's conflicted copy 2026-11-22).md` |

`Note 2.md`, `Note (1).md` and `Note-LAPTOP.md` (iCloud, Google Drive, OneDrive) can't be told apart from real pages by name. They're listed as *possible* copies only when the original exists and most of their lines match.

Gumply changes nothing in a copy until you choose **Keep page**, **Keep copy** or **Keep both**. The side you don't keep goes to the Trash and into the page's history.

## How this format may change

This page describes **version 1**.

- **No silent conversions.** Gumply never rewrites your existing files into a new form on its own, when it opens a vault or when it saves.
- **Additions** (a new optional key, file or syntax that older Gumply versions keep as they are) can come in any release. This page gets a new minor version.
- **A change older versions would misread** only comes in a major release. It comes with a note in the release notes, and with an optional conversion you run yourself. That conversion shows what it will change first, and keeps every changed file's old version in history.
- **Gumply is tolerant when reading.** Keys, files and fields it doesn't know are left as they are, never dropped.
