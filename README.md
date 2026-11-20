# Gumply

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

File names follow page titles, like Obsidian: "Q1 plan" is `Q1 plan.md`, and renaming the page
renames the file (and its sub-page folder). Notes you wrote without frontmatter stay without it.

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
