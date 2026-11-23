import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #ifcn6pvx (a11y, keyboard): Cmd+K gives focus to what it opened, and the
 * sidebar's page tree is one Tab stop (the WAI-ARIA tree pattern: a roving
 * tabindex, arrows inside), so Tab doesn't walk every row of a big vault.
 */

const tree = (page: Page) => page.getByTestId('page-tree');
const row = (page: Page, id: string) => page.getByTestId(`page-item-${id}`);
const focusedId = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[role="treeitem"]')?.getAttribute('data-page-id') ?? null);

async function pick(page: Page, query: string, title: string, by: 'Enter' | 'click') {
  await page.keyboard.press('Control+k');
  await page.getByTestId('quick-switcher-input').fill(query);
  const option = page.getByRole('option', { name: title, exact: false }).first();
  await expect(option).toBeVisible();
  if (by === 'Enter') await page.keyboard.press('Enter');
  else await option.click();
}

test('Cmd+K → a page puts the caret in its editor, by Enter and by click', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Alpha', content: 'Alpha text.' },
    { title: 'Beta', content: 'Beta text.' },
  ]);
  await page.goto('/#/Alpha');
  await expectPageTitle(page, 'Alpha');

  await pick(page, 'Beta', 'Beta', 'Enter');
  await expectPageTitle(page, 'Beta');
  await expect(page.getByTestId('editor-content')).toBeFocused();
  await page.keyboard.type('Typed ');
  await expect(page.getByTestId('editor-content')).toContainText('Typed Beta text.');

  await pick(page, 'Alpha', 'Alpha', 'click');
  await expectPageTitle(page, 'Alpha');
  await expect(page.getByTestId('editor-content')).toBeFocused();
  // The page that is already open: the caret goes back into it too.
  await pick(page, 'Alpha', 'Alpha', 'Enter');
  await expect(page.getByTestId('editor-content')).toBeFocused();
});

test('Cmd+K back to a page puts the caret where it was on it; > trash leaves focus in the view, not on <body>', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Alpha', content: 'Alpha text.' },
    { title: 'Beta', content: 'Beta text.' },
  ]);
  await page.goto('/#/Alpha');
  await expectPageTitle(page, 'Alpha');
  await page.getByTestId('editor-content').getByText('Alpha text.').click();
  await page.keyboard.press('End');

  await pick(page, 'Beta', 'Beta', 'Enter');
  await expectPageTitle(page, 'Beta');
  await pick(page, 'Alpha', 'Alpha', 'Enter');
  await expectPageTitle(page, 'Alpha');
  await expect(page.getByTestId('editor-content')).toBeFocused();
  await page.keyboard.type(' More.');
  await expect(page.getByTestId('editor-content')).toContainText('Alpha text. More.');

  await page.keyboard.press('Control+k');
  await page.getByTestId('quick-switcher-input').fill('> trash');
  await expect(page.getByTestId('command-view.trash')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('trash-view')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== document.body && !!document.activeElement?.closest('main')))
    .toBe(true);
});

test('Cmd+K → a board focuses its canvas; → a database view its first control', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Notes', content: 'Text.' }]);
  await writeFile(path.join(E2E_VAULT, 'Plan board.canvas'), JSON.stringify({ nodes: [], edges: [] }));
  await writeFile(path.join(E2E_VAULT, 'Tasks view.base'), 'views:\n  - type: table\n    name: Table\n');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toEqual(expect.arrayContaining(['Plan board.canvas', 'Tasks view.base']));
  await page.goto('/#/Notes');
  await expectPageTitle(page, 'Notes');

  await pick(page, 'Plan board', 'Plan board', 'Enter');
  await expect(page.getByTestId('board')).toBeFocused({ timeout: 10_000 });

  await pick(page, 'Tasks view', 'Tasks view', 'Enter');
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="base-view"]')), { timeout: 10_000 }).toBe(true);
});

test('the tree is one Tab stop; arrows, Home/End, →/← and type-ahead move inside it', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Apple', content: 'A.' },
    { title: 'Banana', content: 'B.' },
    { title: 'Cherry', content: 'C.' },
  ]);
  const [kid] = await vault.seed([{ title: 'Kiwi', content: 'K.' }]);
  void kid;
  await page.goto('/#/Banana');
  await expectPageTitle(page, 'Banana');

  // Exactly one row is in the Tab order: the open page's; its buttons are not.
  await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await expect(row(page, 'Banana')).toHaveAttribute('tabindex', '0');
  await expect(tree(page).locator('button[tabindex="0"], button:not([tabindex])')).toHaveCount(0);

  await row(page, 'Banana').focus();
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('Cherry');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  expect(await focusedId(page)).toBe('Apple');
  await page.keyboard.press('End');
  expect(await focusedId(page)).toBe('Kiwi');
  await page.keyboard.press('Home');
  expect(await focusedId(page)).toBe('Apple');
  // The roving stop follows focus.
  await expect(row(page, 'Apple')).toHaveAttribute('tabindex', '0');
  await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

  // Type-ahead.
  await page.keyboard.type('ch');
  expect(await focusedId(page)).toBe('Cherry');
  // A pause ends the typed prefix ("chk" would match nothing); "k" starts a new one.
  await page.waitForTimeout(800);
  await page.keyboard.press('k');
  expect(await focusedId(page)).toBe('Kiwi');

  // Enter opens; the ⋯ menu's "New sub-page" (Shift+F10) adds a page inside it.
  await page.keyboard.press('Enter');
  await expectPageTitle(page, 'Kiwi');
  await row(page, 'Kiwi').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('page-menu-Kiwi')).toBeVisible();
  await page.getByTestId('add-page-Kiwi').click();
  await expect.poll(async () => (await vault.pages()).some((meta) => meta.parentId === 'Kiwi')).toBe(true);

  // → expands and enters a parent, ← goes back to it and collapses it. (The new
  // sub-page opened with its title focused; back on Kiwi before using the tree.)
  const child = (await vault.pages()).find((meta) => meta.parentId === 'Kiwi')!;
  await expectPageTitle(page, child.title);
  await page.goto('/#/Kiwi');
  await expectPageTitle(page, 'Kiwi');
  await row(page, 'Kiwi').focus();
  await expect(row(page, 'Kiwi')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'Kiwi')).toHaveAttribute('aria-level', '1');
  await expect(row(page, child.id)).toHaveAttribute('aria-level', '2');
  await expect(tree(page)).toHaveAttribute('aria-label', 'Pages');
  await page.keyboard.press('ArrowRight');
  expect(await focusedId(page)).toBe(child.id);
  await page.keyboard.press('ArrowLeft');
  expect(await focusedId(page)).toBe('Kiwi');
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'Kiwi')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'Kiwi')).toHaveAttribute('aria-expanded', 'true');
});

test('a 300-page vault: the tree takes one Tab, and the editor is a few Tabs past the sidebar', async ({ page, request }) => {
  test.setTimeout(90_000);
  await mkdir(E2E_VAULT, { recursive: true });
  for (let i = 0; i < 300; i += 1) await writeFile(path.join(E2E_VAULT, `Page ${String(i).padStart(3, '0')}.md`), `Text ${i}.\n`);
  await expect.poll(async () => (await api.listPages(request)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(300);
  await page.goto('/#/Page%20150');
  await expectPageTitle(page, 'Page 150');

  // From the first sidebar control, Tab until the editor; count the stops and the tree rows passed.
  await page.getByTestId('sidebar-search').focus();
  const seen: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return 'none';
      if (active.closest('[data-testid="editor-content"]')) return 'editor';
      const item = active.closest('[role="treeitem"]');
      return item ? `tree:${item.getAttribute('data-page-id')}` : active.getAttribute('data-testid') ?? active.tagName;
    });
    seen.push(where);
    if (where === 'editor') break;
  }
  expect(seen.at(-1)).toBe('editor');
  expect(seen.filter((stop) => stop.startsWith('tree:'))).toEqual(['tree:Page 150']);
  expect(seen.length).toBeLessThanOrEqual(15);
});
