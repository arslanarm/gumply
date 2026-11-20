import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Vault } from './fixtures';

/**
 * Screenshot capture for review notes (not assertions and not pixel diffs).
 * Run with `npm run test:e2e:screens`; output: `test-results/screens/`.
 */
const SCREENS_DIR = fileURLToPath(new URL('../test-results/screens/', import.meta.url));
const THEME_KEY = 'gumply:theme';

const PAGES = [
  {
    title: 'Welcome',
    content: [
      '# Welcome to Gumply',
      '',
      'Gumply is a quiet place for notes: simple blocks, no clutter.',
      '',
      'Jump into [[Projects]] or read the latest [[Meeting notes]].',
      '',
      '- [ ] Create your first page',
      '- [x] Link two pages together',
      '',
      '> Notes stay as plain Markdown files on disk.',
    ].join('\n'),
  },
  {
    title: 'Projects',
    content: [
      '# Projects',
      '',
      'A short list with a link back to [[Welcome]].',
      '',
      '1. Ship the Q1 quality pass',
      '2. Review the graph',
      '',
      '```',
      'const status = "in progress";',
      '```',
    ].join('\n'),
  },
  {
    title: 'Meeting notes',
    content: [
      '# Meeting notes',
      '',
      '## Agenda',
      '',
      '- Visual quality bar',
      '- Attachments',
      '',
      'Back to [[Welcome]].',
    ].join('\n'),
  },
];

async function seed(vault: Vault) {
  // Parents before children; order also gives the tree several rows.
  await vault.seed(PAGES);
}

async function open(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: THEME_KEY, value: theme },
  );
  await page.goto('/');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  // The app auto-opens the first root (alphabetically); pin Welcome for a
  // consistent editor screenshot with backlinks.
  await page.getByTestId('page-item-welcome').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('page-title')).toHaveText('Welcome');
}

async function shot(page: import('@playwright/test').Page, name: string) {
  await page.screenshot({ path: path.join(SCREENS_DIR, name), fullPage: true });
}

test.beforeAll(() => {
  rmSync(SCREENS_DIR, { recursive: true, force: true });
  mkdirSync(SCREENS_DIR, { recursive: true });
});

for (const theme of ['light', 'dark'] as const) {
  test(`key surfaces — ${theme}`, async ({ page, vault }) => {
    test.setTimeout(60_000);
    await seed(vault);
    await open(page, theme);

    // 01 — page + editor + sidebar + backlinks panel.
    await shot(page, `${theme}-01-editor.png`);

    // 02 — global graph, settled.
    await page.getByTestId('sidebar-graph').click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, `${theme}-02-graph.png`);

    // 03 — quick switcher with results.
    await page.getByTestId('sidebar-search').click();
    await expect(page.getByTestId('quick-switcher')).toBeVisible();
    await page.keyboard.type('Pro');
    await expect(page.getByTestId('search-result-projects')).toBeVisible();
    await shot(page, `${theme}-03-search.png`);
    await page.keyboard.press('Escape');

    // 04 — a page with backlinks + the local graph panel.
    await page.getByTestId('page-item-welcome').click();
    await page.getByTestId('local-graph-toggle').click();
    await expect(page.getByTestId('local-graph-canvas')).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, `${theme}-04-local-graph.png`);
  });

  test(`empty states and 404 — ${theme}`, async ({ page, vault }) => {
    test.setTimeout(30_000);
    await vault.reset();
    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: THEME_KEY, value: theme },
    );

    await page.goto('/');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('new-page-button')).toContainText('New page');
    await shot(page, `${theme}-05-empty.png`);

    await page.goto('/#/missing-page');
    await expect(page.getByTestId('page-not-found')).toBeVisible();
    await shot(page, `${theme}-06-404.png`);
  });
  test(`P2 polish surfaces — ${theme}`, async ({ page, vault }) => {
    test.setTimeout(60_000);
    await seed(vault);
    await open(page, theme);

    // Slash menu with block icons and scroll affordance.
    await page.getByTestId("new-page-button").click();
    await page.getByTestId("page-title-input").waitFor();
    await page.getByTestId("editor-content").waitFor();
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await page.waitForTimeout(180);
    await shot(page, `${theme}-07-slash-menu.png`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");

    // [[ menu with page/file icons.
    await page.keyboard.type("[[");
    await expect(page.getByTestId("link-menu")).toBeVisible();
    await page.waitForTimeout(180);
    await shot(page, `${theme}-08-link-menu.png`);
    await page.keyboard.press("Escape");

    // Toast with its icon, deleting a page that is not open.
    await page.getByTestId("page-item-welcome").click();
    await page.locator('[data-testid="page-menu-button-meeting-notes"]').click();
    await page.locator('[data-testid="delete-page-meeting-notes"]').click();
    await expect(page.getByTestId("undo-toast")).toBeVisible();
    await page.waitForTimeout(180);
    await shot(page, `${theme}-09-toast.png`);
  });
}
