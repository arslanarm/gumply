# Gumply

[![CI](https://github.com/arslanarm/gumply/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/arslanarm/gumply/actions/workflows/ci.yml)

A local-first note app with Notion's simplicity and Obsidian's visualizations: nested Markdown
pages, wikilinks, backlinks and a graph view. Notes live as plain `.md` files in a vault folder.

## User guide

How to use Gumply, from installing it to boards, version history and sync:
**[User guide (English)](docs/guide/en/README.md)** · **[Руководство (русский)](docs/guide/ru/README.md)**.
The desktop app opens it from **Help → User Guide**.

## Stack

- TypeScript everywhere, npm workspaces monorepo
- `packages/core` — shared types, frontmatter parsing, wikilink/tag extraction
- `apps/server` — Node + Hono API over the vault folder
- `apps/web` — Vite + React + TipTap editor
- Vitest (unit), Playwright (e2e, later)

## Quickstart

Requires Node 20+.

```bash
npm install
npm run dev
```

- Web UI: http://localhost:5173
- API: http://localhost:8787/api/health

The vault defaults to `./vault` and is created on first start. Point it elsewhere with
`GUMPLY_VAULT=/path/to/notes`. Set the API port with `GUMPLY_PORT` (default `8787`).

**The API stays on your computer.** It can read and change every note, so it listens on
`127.0.0.1` only, sends no CORS headers, refuses requests whose `Host` isn't this machine (DNS
rebinding), and refuses writes whose `Origin` isn't the Gumply web app. The web app is
recognised through the Vite proxy on any port (`npm run dev`, `vite --port …`, `vite preview`),
so nothing needs configuring.
- `GUMPLY_WEB_PORT` (default `5173`, comma-separated): extra web-app port(s) allowed to write
  when the app doesn't go through Gumply's Vite proxy (e.g. a custom reverse proxy). The server
  logs a hint when it refuses a write.
- `GUMPLY_HOST`: listen on another interface, e.g. your LAN address `192.168.1.20`; that name is
  then also accepted as `Host`. Anyone on that network can then read and change your notes, and
  the server prints a warning.

File names follow page titles, like Obsidian: "Q1 plan" is `Q1 plan.md`, and renaming the page
renames the file (and its sub-page folder). Notes you wrote without frontmatter stay without it.

## Desktop app (Linux, Windows, macOS)

Gumply also runs as a desktop app (Electron, D26). It contains the same local server and web app,
so your notes are still plain Markdown files in a folder you choose.

- **Try it from source:** `npm run desktop:dev` builds the web app and the desktop shell, then opens
  the window. (Rebuilds on every start; for UI work, `npm run dev` in a browser is faster.)
- **Build installers:** `npm run desktop:build:linux` writes `apps/desktop/release/Gumply-<version>-x86_64.AppImage`
  and `Gumply-<version>-amd64.deb`. Run the AppImage directly (`chmod +x` it first), or install the
  .deb with `sudo apt install ./Gumply-<version>-amd64.deb`.
- **Linux, which file:**
  - **The `.deb`** (Ubuntu, Debian) installs to `/opt/Gumply` with an AppArmor profile, so on
    Ubuntu 23.10+ (which restricts unprivileged user namespaces) the app keeps Chromium's sandbox.
  - **The AppImage** runs anywhere without installing. Since v0.8 it uses AppImage's static runtime,
    so it needs only FUSE 3 (`fusermount`, from the `fuse3` package, installed by default on Ubuntu
    22.04+); older Gumply AppImages needed `libfuse2` (`sudo apt install libfuse2t64`). Where
    user namespaces are restricted (Ubuntu 23.10+), the AppImage's launcher starts Gumply without
    Chromium's sandbox rather than not at all (electron-builder's own fallback). If you want the
    sandbox on Ubuntu 23.10+, use the `.deb`.
  - `APPIMAGE_EXTRACT_AND_RUN=1` (for systems without FUSE) isn't needed with 0.8+ AppImages. With
    older ones, don't use it for the AI apps (MCP) command: it printed the extracted files to
    standard output, which is the MCP connection.
- **Windows and macOS:** built on GitHub Actions (`.github/workflows/desktop.yml`). A `v*` tag builds
  all three platforms (Windows installer `.exe`; macOS `.dmg`/`.zip` for Apple silicon and Intel)
  and attaches them, with `SHA256SUMS.txt`, to a **draft** GitHub Release that is published after
  the release check. `ci/**` branches build the same installers as workflow artifacts. The builds
  are **not signed yet**, so the first start needs one confirmation:
  - **Windows:** SmartScreen says "Windows protected your PC" → **More info → Run anyway**.
  - **macOS** (`-arm64` for Apple silicon, `-x64` for Intel): drag Gumply to Applications and open
    it; macOS blocks it. Then open **System Settings → Privacy & Security**, scroll to "Gumply was
    blocked…", click **Open Anyway** and confirm. (On macOS 15 and later, right-click → Open no
    longer skips this.) Alternatively, run `xattr -dr com.apple.quarantine /Applications/Gumply.app`.
- **Hardened builds:** the shipped app can't be started as plain Node, ignores `NODE_OPTIONS` and
  debugging flags, and only loads its own integrity-checked app archive (Electron fuses). CI checks
  this in every installer with `npm run check:fuses -w @gumply/desktop`.
- **Installer inspection:** after packaging, every CI build unpacks its own installers and checks
  them (`apps/desktop/scripts/inspect-installers.mjs`): the file and app names, the version stamped
  everywhere, the Windows description, the `.deb` fields and checksums, the fuses of the binary
  inside, the app archive (no `node_modules`, source maps or secrets), the macOS signature, and the
  update files (`latest*.yml` with the version and every file's sha512, the Windows blockmap, and each
  app's `app-update.yml` pointing at this repo's GitHub Releases). The
  results are in the job summary, and the release job checks the uploaded files against the
  SHA-256 sums the build computed. Locally: `node apps/desktop/scripts/inspect-installers.mjs
  --release apps/desktop/release --version <version>` (Node 24 or later). Each build then installs
  its own app as a user would (Windows installer, macOS `.dmg`, Linux AppImage) and checks that it
  starts, ships its licences file, exports a PDF and serves a vault to an AI app from the Claude
  Desktop snippet (`apps/desktop/e2e/packaged.spec.ts`; locally: `GUMPLY_PACKAGED_APP=<installed
  app> npm run desktop:test -- packaged.spec.ts`).
- **Real `.deb` install:** the Linux CI job also installs the `.deb` (`apps/desktop/scripts/deb-smoke.sh`,
  CI only since it needs sudo) with user namespaces restricted as on stock Ubuntu 23.10+, and checks
  that its AppArmor profile is loaded, that the app and the AI apps (`--mcp`) command run with
  Chromium's sandbox (no `--no-sandbox`), and that purging removes the profile.
- **Vaults:** on first start Gumply asks you to open a folder (any Obsidian vault works) or create
  a new vault; a new or empty folder gets the demo notes. **File → Open Vault… / Create New Vault… /
  Open Recent / Reveal Vault in File Manager** switch and find vaults. The list of vaults and the
  window size are stored in your user config folder (`~/.config/Gumply/gumply-desktop.json`), never
  in a vault.
- **Safety:** the server inside the app listens on `127.0.0.1` on a random port, the window can't
  leave the app, and web or mail links open in your normal browser or mail app. Files you open from a
  note (e.g. a PDF card) open in their default app.
- **Tests:** `npm run desktop:test` runs smoke tests against the real app on a virtual display.
  **Never let a test window reach a real desktop.** On Wayland, Electron ignores `xvfb-run` unless it
  is forced to X11, so every test or script launch must: unset `WAYLAND_DISPLAY`, pass
  `--ozone-platform=x11`, and run under `xvfb-run`. The test launcher (`apps/desktop/scripts/test.mjs`
  and `launch()` in `apps/desktop/e2e/desktop.spec.ts`) does all three; copy it for any new launch.
- If npm skipped Electron's download (npm can block install scripts), the desktop build fetches it.
- **Restricted user namespaces (Ubuntu 23.10+), development:** Electron from `node_modules` has no
  AppArmor profile, so Chromium's sandbox can't start and the app aborts ("SUID sandbox helper… not
  configured"). The development MCP command (Settings → AI apps, and `apps/desktop/e2e/mcp.spec.ts`)
  then adds `--no-sandbox`, decided by the same `unshare -Ur true` probe as the AppImage launcher.

## Scripts (from repo root)

| Command | What it does |
|---|---|
| `npm run dev` | Builds core, then runs core watch + API + web together |
| `npm test` | Vitest unit tests |
| `npm run build` | Type-checks and builds core, server and web |
| `npm run typecheck` | Type-checks every workspace |
| `npm run test:e2e` | Playwright e2e suite (local, throwaway vault) |
| `npm run vault:sync-filenames` | Dry run: list files whose names don't follow their `title:` yet. Add `-- --apply` to rename them |
| `npm run emoji:data` | Regenerate the emoji list from `emojibase-data` |
| `npm run seed:big` | Seed 200 linked pages via the API for graph/performance checks (`-- 500` for more) |

## Development

Before moving a task to review, run `npm run typecheck`: it type-checks every workspace
(core, server, web) and exits non-zero on the first error. `npm test` runs the Vitest suite;
`npm run test:e2e` runs the Playwright flows against a throwaway vault.

Use the Node version in `.nvmrc` (24 LTS); Node 22 is also tested in CI. (Node 20/22's recursive
`fs.watch` loses files that are replaced atomically, so the vault watcher uses one watcher per folder;
see #3ugdxhzu.)

**CI** (`.github/workflows/ci.yml`, GitHub Actions) runs on every push to `main` and `ci/**`, on
every `v*` tag, and by hand. Pushing a branch as `ci/<task-id>` is how unmerged work gets a real
run; only @lead pushes to GitHub.
- **checks:** typecheck, unit tests and build on **Node 22 and 24**. Node 22 stays in so the
  vault-watcher regression test keeps running there.
- **e2e:** the full suite (Chromium, plus Firefox for the graph specs) on the Node in `.nvmrc`.

A newer push cancels an older run. On failure the Playwright report and `test-results/` are
uploaded as an artifact.

## API

Base `/api`, JSON. Full contract in the team wiki (`spec/api`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + vault path |
| GET | `/pages` | flat `PageMeta[]` (client builds the tree from `parentId`) |
| POST | `/pages` | create `{ title, parentId?, content?, icon? }` (201) |
| GET | `/pages/:id` | page with Markdown body |
| PUT | `/pages/:id` | update `{ title?, content?, icon?, tags? }`; a title change rewrites `[[old]]` links elsewhere and returns `rewrittenPages` |
| DELETE | `/pages/:id` | move page + sub-pages to `.trash/`, returns `{ trashId, deleted }` |
| POST | `/trash/:trashId/restore` | undo a delete; returns restored `PageMeta[]` (409 if the path is taken) |
| POST | `/pages/:id/move` | `{ parentId }` (null = root) |
| GET | `/pages/:id/backlinks` | `{ page, snippet }[]` |
| GET | `/graph?center=&depth=` | nodes with `linkCount`, resolved links, tags, and `unresolved` source/title pairs (ghost nodes) |
| GET | `/search?q=` | `{ page, snippet, score }[]`, title hits first |

Ids are URL-encoded in paths (`projects%2Fgumply`). `PageMeta` includes `childCount` (direct
sub-pages). Writes go to plain Markdown files with YAML frontmatter (`title`, `icon`, `tags`,
`created`, `updated`); the in-memory link index is rebuilt on start and kept in sync on every
write. Deleted pages live under `vault/.trash/<trashId>/` and are invisible to the API. Invalid or
`..`-style ids return `400`.

## Graph view

`#graph` (or the sidebar **Graph** row) shows every page as a node: size follows the link count,
colour follows the first tag (folder fallback), hovering highlights neighbours, clicking opens the
page. Missing targets appear as dashed ghost nodes grouped by title — click one to create that page.
The toolbar has a title filter and tag chips; `+`/`−`/**Fit** control the canvas. A page's header has
a **Local graph** toggle that opens a 320px panel at depth 1 or 2. Testids: `graph-canvas`,
`local-graph`.

## Whiteboards

Miro-style boards that live in the page tree next to your pages (D25, spec in the wiki
`spec/whiteboard`).

**Create one** with **New whiteboard** in the sidebar, **Add whiteboard inside** in a page's ⋯ menu,
`/whiteboard` in the editor (creates it inside the current page and links to it), or Cmd/Ctrl+K →
**Create whiteboard “X”**. New whiteboard opens a gallery: **Blank** or a template (Kanban, Mind
map, Retrospective, Flowchart, Weekly plan), also reachable with `/template` and Cmd/Ctrl+K →
**New board from template…**. A board made from a template is an ordinary `.canvas` file. Boards can be renamed, moved, deleted and restored like pages; they have
no sub-pages.

**On the board:** stickies, text, shapes, frames, connectors with labels, the pen, images and files,
and page cards (drag a page from the sidebar onto the board). Shortcuts: V select, H hand, N sticky,
T text, S shape, C/L connector, F frame, P pen, Shift+1 fit; `?` lists them all. Everything autosaves,
and undo/redo covers every change.

**Export:** the board's ⋯ menu exports the whole board or the selection as **PNG** (2×) or **SVG**,
on the theme background or transparent. SVGs are plain vector files (shapes, connectors and real
text, with the Inter font embedded), so they open the same in browsers and design tools. In the
desktop app, export asks where to save the file.

**Your files:** a board is a plain `<Title>.canvas` file in the open
[JSON Canvas](https://jsoncanvas.org) format, written exactly as Obsidian writes it, so boards open
and save in Obsidian without changes, and Obsidian's own boards open in Gumply.
- Gumply-only details (sticky/shape/pen data, a board's icon and tags) are extra keys Obsidian keeps;
  Gumply never invents new node types.
- Page cards and `[[links]]` on a board count as links: they show up in **Linked from**, the graph
  (boards are squares) and search. Renaming or moving a page updates the boards that show it.
- Links Gumply writes to a board include the extension, e.g. `[[Project map.canvas|Project map]]`,
  because Obsidian only resolves `.canvas` links that way. `[[Project map]]` also works in Gumply.
- **Display titles:** the file name follows the title (D20). When the title has characters a file
  name can't hold, e.g. "Roadmap: Q3?" in `Roadmap Q3.canvas`, the full title is kept inside the
  board (`"gumply": { "title": … }`). Renaming the file in Obsidian makes the new file name the title.
- Edits made outside Gumply are never silently overwritten: a save that would replace them asks
  **Reload** or **Keep mine** (Keep mine keeps a backup), as for pages. A board file with entries Gumply can't keep is
  backed up to `.gumply/conflicts/` before the first save.

## AI apps (MCP)

Claude Code, Claude Desktop and other MCP clients can search and read a vault, and add to it if you allow it,
through Gumply's local MCP server (stdio only, no network port). Read only by default; every change is kept in
history and can be undone. Set it up from **Settings → AI apps (MCP)…**, which gives a ready-to-paste snippet with
full paths; see [docs/mcp.md](docs/mcp.md) for the snippets per app and OS, access levels and troubleshooting.

## Import from Notion

In Notion, export a workspace or page as **Markdown & CSV** with **Include subpages** on. Then use
**Import from Notion…** (Cmd/Ctrl+K, the desktop File menu, or a folder's ⋯ menu) and pick the zip.
Everything goes into a new `Notion import` folder (`Notion import 2` for the next one); nothing already in
the vault is changed.

**What comes across:**
- **Pages and sub-pages**, as Gumply's nested pages. Links between pages and @-mentions become `[[links]]`.
- **Images and files**, copied to `attachments/Notion import/` and linked with standard Markdown links.
- **Callouts** become Obsidian callouts, and code blocks keep their language.
- **Databases** become a folder with one page per row. The row's properties are written as typed frontmatter:
  numbers, dates, date-times, checkboxes, lists, and relations as `[[links]]`. Each database also gets a
  `.base` view next to it: a table in Notion's column order, plus a board where the export shows the
  database was one.
- **Property types** are added to the vault's types only for names it doesn't type yet. The vault's own types
  win, compared regardless of case (`Due` is `due`), as Obsidian does.

**What doesn't:** Notion's export carries no view settings, so filters, sorts, calendar and gallery views, option
colours and comments are left out. Formulas, rollups and people arrive as their text, and file properties as file
names.

**The report** lists what was converted, what was left out and why. It's shown when the import finishes and saved
as `Import report.md` in the new folder, in the app's language.

## Export

A page's ⋯ menu in the sidebar and Cmd/Ctrl+K export it:
- **Export as HTML…** writes one self-contained `.html` file: the page with its images, previews, database
  snapshots, math and diagrams. It opens in any browser, offline. Choose the theme, and whether links to other
  pages stay as plain text or point to sibling `.html` files.
- **Export as PDF…** prints the page in the light theme, with its cover, title, images, math and diagrams, on A4
  or Letter with normal or narrow margins. The desktop app saves the PDF through a Save dialog (also in its File
  menu); in a browser, the browser's print dialog opens, where you choose "Save as PDF".

## Columns

Put blocks side by side:
- **drag a block onto another block's left or right edge** (up to 5 columns);
- `/columns` makes 2, 3 or 4 columns, and a block's ⋯ menu has **Turn into → Columns**;
- **Mod+Alt+←/→** moves a block between columns.

Drag the gutter between columns to resize them (each column keeps at least 15%); double-click it to make them
equal. An emptied column goes away, and columns stack on narrow windows. On disk, columns are
[Pandoc fenced divs](https://pandoc.org/MANUAL.html#divs-and-spans), so the file stays plain Markdown:

```markdown
:::: {.columns}
::: {.column width="40%"}
Left side
:::
::: {.column width="60%"}
Right side
:::
::::
```

Obsidian shows the `:::` lines as text, with the content one column after the other. The HTML and PDF exports
lay them out side by side.

## Outline

The **Outline** lists the open page's headings (a board's frames) in the right-hand column, next to the
**Local graph** tab. Click an entry to jump to it, and collapse or expand sections. Toggle it with the header
button or **Ctrl/Cmd+Shift+O** (**Ctrl/Cmd+Alt+O** if the browser keeps the first shortcut).

## Tags and aliases

Tags and aliases in frontmatter are read as Obsidian reads them:
- the keys `tags` and `aliases` count in any case (`Tags:`, `TAGS:`), plural only; `tag:` and `alias:` are
  ordinary properties;
- if a note has two spellings (`tags:` and `Tags:`), the first in the file is read and edited, and the other is
  left as written.

Obsidian only reads tags written as a list. A `tags: a, b` text value still shows its tags in Gumply, with a
warning that Obsidian won't read them and a **Make it a list** button that rewrites just that value as a list.
Tags made only of digits (`2024`) get a warning too, since Obsidian doesn't count them.

## Languages

The interface is in English and Russian, following your system language. Change it in
Settings (the 文A button in the top bar) or with Cmd/Ctrl+K → **Language…**. To add a
language, see [docs/translating.md](docs/translating.md).

## Layout

```
apps/
  server/   Hono API (routes.ts), vault store + link index (vault-store.ts)
  web/      React UI (Vite); graph view in src/graph/
packages/
  core/     types, frontmatter, links, ids
scripts/    seed-big.mjs
```

## Status

M0 scaffold, M1a vault server (spec/api v1.2) and M3 graph view: page CRUD, nested move,
trash + restore, rename with link rewriting, backlinks, global graph with ghost nodes, local
graph panel and search, all with Vitest coverage. M1b provides the page shell and TipTap editor;
wikilinks/backlinks UI (M2) and search overlay (M4) are next.
See the team wiki (`plan`, `decisions`, `spec/api`) for the API contract and roadmap.

## License

[MIT](LICENSE) © 2026 Arslan Armanuly

Third-party fonts: board exports embed [Inter](https://github.com/rsms/inter) (© The Inter Project
Authors), under the SIL Open Font License 1.1: see `apps/web/src/board/export/fonts/OFL.txt`.
