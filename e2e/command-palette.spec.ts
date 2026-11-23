import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * v0.9 H (#snuin2ja): every action in Cmd+K. `>` lists only commands, grouped,
 * and only those that apply where the palette was opened; plain typing shows
 * the best few after the pages. Commands run end to end.
 */

const palette = (page: Page) => page.getByTestId('quick-switcher');
const input = (page: Page) => page.getByTestId('quick-switcher-input');

async function openPalette(page: Page, query: string) {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await input(page).fill(query);
}

async function run(page: Page, query: string, testId: string) {
  await openPalette(page, query);
  const row = page.getByTestId(testId);
  await expect(row).toBeVisible();
  await row.click();
  await expect(palette(page)).toHaveCount(0);
}

async function openNote(page: Page, vault: { seed: (pages: { title: string; content?: string }[]) => Promise<{ id: string }[]> }) {
  await vault.seed([{ title: 'Plan', content: 'First line.' }]);
  await page.goto('/#/Plan');
  await expect(page.getByTestId('editor-content')).toContainText('First line.');
}

test('> lists only commands, grouped, with shortcut hints; page commands name the page', async ({ page, vault }) => {
  await openNote(page, vault);
  await openPalette(page, '>');
  await expect(page.getByTestId('command-group-page')).toHaveText('This page · Plan');
  for (const group of ['new', 'editor', 'views', 'settings', 'help']) await expect(page.getByTestId(`command-group-${group}`)).toBeVisible();
  // No board here, and no page results in commands mode.
  await expect(page.getByTestId('command-group-board')).toHaveCount(0);
  await expect(page.getByTestId('search-result-Plan')).toHaveCount(0);
  // The shortcut is on the row, from the same keys as the ? dialog.
  await expect(page.getByTestId('search-today').locator('kbd')).toHaveText(['Ctrl', 'Shift', 'D']);
  await expect(page.getByTestId('search-today')).toHaveAttribute('aria-keyshortcuts', 'Ctrl+Shift+D');

  // A query in commands mode: the matches, best first; nothing matching says so.
  await input(page).fill('> theme dark');
  await expect(page.getByRole('option').first()).toHaveAttribute('data-testid', 'command-settings.theme-dark');
  await input(page).fill('> zzqx');
  await expect(page.getByTestId('search-empty')).toHaveText('No command matches “zzqx”');
});

test('context: no page commands in a view; board commands only on a board', async ({ page, vault, request }) => {
  await openNote(page, vault);
  await run(page, '> trash', 'command-view.trash');
  await expect(page.getByTestId('trash-view')).toBeVisible();
  await openPalette(page, '>');
  await expect(page.getByTestId('command-group-new')).toBeVisible();
  await expect(page.getByTestId('command-group-page')).toHaveCount(0);
  await expect(page.getByTestId('command-group-editor')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const created = await request.post(`${API_URL}/api/boards`, { data: { title: 'Map' } });
  expect(created.status()).toBe(201);
  await page.goto('/#/Map.canvas');
  await expect(page.getByTestId('board-page')).toBeVisible();
  await openPalette(page, '>');
  await expect(page.getByTestId('command-group-board')).toBeVisible();
  await expect(page.getByTestId('command-group-editor')).toHaveCount(0);
  // A board has history but no HTML export.
  await expect(page.getByTestId('search-history')).toBeVisible();
  await expect(page.getByTestId('search-export-html')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Board tool and fit, end to end.
  await run(page, '> pen', 'command-board.tool.pen');
  await expect(page.getByTestId('board-tool-pen')).toHaveAttribute('aria-pressed', 'true');
  // Focus is back on the board: its own keys work right away.
  await page.keyboard.press('v');
  await expect(page.getByTestId('board-tool-select')).toHaveAttribute('aria-pressed', 'true');
  // Shape from Cmd+K shows the shape choices, as S does.
  await run(page, '> board tool shape', 'command-board.tool.shape');
  await expect(page.getByTestId('board-tool-shape')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('board-shape-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await run(page, '> zoom in', 'command-board.zoom-in');
  await expect(page.getByTestId('board-zoom-value')).not.toHaveText('100%');
  await run(page, '> zoom 100', 'command-board.zoom-reset');
  await expect(page.getByTestId('board-zoom-value')).toHaveText('100%');
});

test('commands run: theme, new page, history, Turn into, show tags', async ({ page, vault, request }) => {
  await openNote(page, vault);

  await run(page, '> theme dark', 'command-settings.theme-dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('editor-content')).toContainText('First line.');

  // Turn into: the block at the caret becomes a heading; the file says so.
  await page.getByTestId('editor-content').getByText('First line.', { exact: true }).click();
  await run(page, '> turn into heading 1', 'command-editor.turn-into.h1');
  await expect(page.getByTestId('editor-content').locator('h1')).toHaveText('First line.');
  await expect.poll(() => readFile(path.join(E2E_VAULT, 'Plan.md'), 'utf8'), { timeout: 10_000 }).toContain('# First line.');

  // Insert: a / menu item below the caret's block.
  await page.getByTestId('editor-content').locator('h1').click();
  await run(page, '> insert divider', 'command-editor.insert.divider');
  await expect(page.getByTestId('editor-content').locator('hr')).toHaveCount(1);
  await expect(page.getByTestId('editor-content').locator('h1')).toHaveText('First line.');

  await run(page, '> history', 'search-history');
  await expect(page.getByTestId('history-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-dialog')).toHaveCount(0);

  await run(page, '> show tags', 'command-view.tags');
  await expect(page.getByTestId('tags-pane-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('tags-pane-toggle')).toBeFocused();

  const before = ((await (await request.get(`${API_URL}/api/pages`)).json()) as unknown[]).length;
  await run(page, '> new page', 'command-new.page');
  await expect.poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as unknown[]).length).toBe(before + 1);
  await expect(page).not.toHaveURL(/#\/Plan$/);
});

test('plain typing: pages first, then a Commands section; Enter runs the highlighted command', async ({ page, vault }) => {
  await vault.seed([{ title: 'Export checklist', content: 'x' }, { title: 'Plan', content: 'First line.' }]);
  await page.goto('/#/Plan');
  await expect(page.getByTestId('editor-content')).toContainText('First line.');
  await openPalette(page, 'export');
  const options = page.getByRole('option');
  await expect(options.first()).toHaveAttribute('data-testid', 'search-result-Export checklist');
  await expect(page.getByTestId('search-commands-heading')).toHaveText('Commands');
  await expect(page.getByTestId('search-export-html')).toContainText('Export page as HTML');
  await expect(page.getByTestId('search-export-html')).toContainText('This page');
  // Keyboard: down to the command, Enter runs it.
  await input(page).fill('font serif');
  await expect(page.getByTestId('command-settings.font-serif')).toBeVisible();
  const index = await options.evaluateAll((items) => items.findIndex((item) => item.getAttribute('data-testid') === 'command-settings.font-serif'));
  for (let step = 0; step < index; step += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-page-font', 'serif');
  // Two letters aren't enough for a command; a #tag never is.
  await openPalette(page, 'fo');
  await expect(page.getByTestId('search-commands-heading')).toHaveCount(0);
});

test('ru: Russian and English words find the same command', async ({ page, vault }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await openNote(page, vault);
  await openPalette(page, '> тема');
  await expect(page.getByTestId('command-settings.theme-dark')).toHaveText('Тема: тёмная');
  await expect(page.getByTestId('command-settings.theme-light')).toBeVisible();
  await expect(page.getByTestId('command-settings.theme-system')).toBeVisible();
  await input(page).fill('> theme dark');
  await expect(page.getByRole('option').first()).toHaveAttribute('data-testid', 'command-settings.theme-dark');
  await input(page).fill('> экспорт');
  await expect(page.getByTestId('search-export-html')).toBeVisible();
  await expect(page.getByTestId('search-export-pdf')).toBeVisible();
});

test('the desktop menu sends registry ids (and an older shell\'s ids still work)', async ({ page, vault, request }) => {
  await openNote(page, vault);
  const count = async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as unknown[]).length;
  const before = await count();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gumply:command', { detail: 'new.page' })));
  await expect.poll(count).toBe(before + 1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gumply:command', { detail: 'new-page' })));
  await expect.poll(count).toBe(before + 2);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gumply:command', { detail: 'view.search' })));
  await expect(palette(page)).toBeVisible();
});

test('Help: the user guide opens in a new tab, in the app\'s language', async ({ page, vault }) => {
  await openNote(page, vault);
  await page.evaluate(() => {
    (window as unknown as { opened: unknown[] }).opened = [];
    window.open = ((...args: unknown[]) => {
      (window as unknown as { opened: unknown[] }).opened.push(args);
      return null;
    }) as typeof window.open;
  });
  await run(page, '> user guide', 'command-help.guide');
  // #dcd579sc: a picked command runs a frame after the palette closes (App.tsx onCommand), so wait for it.
  await expect.poll(() => page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([
    ['https://github.com/arslanarm/gumply/blob/main/docs/guide/en/README.md', '_blank', 'noopener'],
  ]);
  // Plain typing never offers Insert / Turn into (they're for `>`).
  await openPalette(page, 'insert table');
  await expect(page.getByTestId('command-editor.insert.table')).toHaveCount(0);
  await input(page).fill('> insert table');
  await expect(page.getByTestId('command-editor.insert.table')).toBeVisible();
});
