# Gumply e2e tests (Playwright)

Owned by **@qa**. Sibling teams: please don't edit `e2e/` — send a message instead.
Full flow list, selector contract and bug format: wiki page **`spec/e2e-tests`**.
Ports follow decision **D7** for the app, but the suite uses its **own** ports so it
never collides with a dev server: **web 5477, API 8977** by default
(`GUMPLY_WEB_PORT` / `GUMPLY_PORT` to override).

## Run

```bash
npx playwright test --config e2e/playwright.config.ts   # = npm run test:e2e
```

Stop any running `npm run dev` first. The suite boots its own app on
**5477 + 8977** with `GUMPLY_VAULT=<throwaway dir>` and **wipes that vault
between tests**; it deliberately never reuses an existing server, because that
server could be pointed at your real notes. Override ports with
`GUMPLY_WEB_PORT` / `GUMPLY_PORT` if those are taken too.

Browsers: `npx playwright install chromium firefox`. Chromium runs the full
suite; Firefox runs the two graph canvas specs (`graph-visual.spec.ts` and
`graph-pixels.spec.ts`) for the Q1b cross-browser check.

Screenshots for review notes (not assertions, not pixel diffs):

```bash
npm run test:e2e:screens   # writes test-results/screens/<theme>-*.png
```


Root `package.json` needs (add once M0 lands):

```jsonc
"devDependencies": { "@playwright/test": "^1.65.1" },
"scripts": { "test:e2e": "playwright test --config e2e/playwright.config.ts" }
```

## Layout

| Path | What it is |
|---|---|
| `playwright.config.ts` | config; starts `npm run dev` on 5173/8787 against a throwaway vault |
| `support/env.ts` | `GUMPLY_WEB_URL`, `GUMPLY_PORT`, `GUMPLY_VAULT` + defaults (single source of truth) |
| `support/api.ts` | typed client for `/api` — tests seed data with this, not via clicks |
| `fixtures.ts` | `vault` fixture: resets before/after each test, `seed()` creates pages via the API |
| `smoke.spec.ts` | app boots, API-seeded page shows in the sidebar and opens |
| `*.spec.ts` | flows A–F, added as milestones land |

## Conventions

- One spec file per flow group (`pages`, `editor`, `links`, `graph`, `find`).
- Assert on user-visible text and `data-testid`s only — never CSS selectors or
  internal React state.
- A test that catches a real bug stays in the suite (fix + regression guard).
- Console `error` / uncaught `pageerror` counts as a failure in smoke tests.
