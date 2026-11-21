# Gumply

[![CI](https://github.com/arslanarm/gumply/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/arslanarm/gumply/actions/workflows/ci.yml)

A local-first note app with Notion's simplicity and Obsidian's visualizations: nested Markdown
pages, wikilinks, backlinks and a graph view. Notes live as plain `.md` files in a vault folder.

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
  inside, the app archive (no `node_modules`, source maps or secrets) and the macOS signature. The
  results are in the job summary, and the release job checks the uploaded files against the
  SHA-256 sums the build computed. Locally: `node apps/desktop/scripts/inspect-installers.mjs
  --release apps/desktop/release --version <version>` (Node 24 or later).
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
