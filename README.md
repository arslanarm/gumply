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

## Scripts (from repo root)

| Command | What it does |
|---|---|
| `npm run dev` | Builds core, then runs core watch + API + web together |
| `npm test` | Vitest unit tests |
| `npm run build` | Type-checks and builds core, server and web |
| `npm run typecheck` | Type-checks every workspace |

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

## Layout

```
apps/
  server/   Hono API (routes.ts), vault store + link index (vault-store.ts)
  web/      React UI (Vite)
packages/
  core/     types, frontmatter, links, ids
```

## Status

M0 scaffold + M1a vault server (spec/api v1.1): page CRUD, nested move, trash + restore, rename
with link rewriting, backlinks, graph and search with Vitest coverage. The UI is still the M0
placeholder (M1b).
See the team wiki (`plan`, `decisions`, `spec/api`) for the API contract and roadmap.
