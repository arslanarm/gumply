import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #9ajce8q3: app shortcuts on a non-Latin layout. On ЙЦУКЕН, Ctrl+K arrives as Ctrl+«л» and Ctrl+Z as Ctrl+«я»
 * (Linux and Windows Chromium), so shortcuts read from `event.key` never fired. They now fall back to the key's
 * position. Synthetic keydowns carrying the `key` and `code` a Russian layout sends; synthetic vault.
 */

/** A keydown as a Russian layout sends it, at the focused element. */
async function keydown(page: Page, init: { key: string; code: string; ctrlKey?: boolean; shiftKey?: boolean }) {
  await page.evaluate((options) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }));
  }, init);
}

test('ru layout: Ctrl+л (the K key) opens the quick switcher', async ({ page, vault }) => {
  await vault.seed([{ title: 'Note', content: 'Text.' }]);
  await page.goto('/');
  await expect(page.getByTestId('page-item-Note')).toBeVisible();
  await keydown(page, { key: 'л', code: 'KeyK', ctrlKey: true });
  await expect(page.getByTestId('quick-switcher-input')).toBeFocused();
});

const exists = (relative: string) => fs.access(path.join(E2E_VAULT, relative)).then(() => true, () => false);

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''));
  await expect.poll(async () => {
    const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
    return ids.every((id) => listed.has(id));
  }, { timeout: 10_000 }).toBe(true);
}

test('ru layout: Ctrl+я (the Z key) undoes a rename in a database table', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, {
    'People.base':
      'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n',
    'People/Ann.md': '---\nrole: Cook\n---\nAnn\n',
    'People/Bo.md': '---\nrole: Pilot\n---\nBo\n',
  });
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  // Ann's role cell, Escape to the grid, ArrowLeft onto Name, then typing: a rename.
  await page.getByTestId('base-row-People/Ann').locator('[data-grid-col]').nth(1).click();
  await expect(page.getByTestId('base-cell-editor-People/Ann-note.role').locator('input').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-grid-cell')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('base-grid-cell')).toHaveAttribute('data-active', /^People\/Ann\|file\.name$/);
  await page.keyboard.type('Annie');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists('People/Annie.md')).toBe(true);

  await page.getByTestId('base-table').click({ position: { x: 5, y: 5 } });
  await keydown(page, { key: 'я', code: 'KeyZ', ctrlKey: true });
  await expect.poll(() => exists('People/Ann.md')).toBe(true);
  expect(await exists('People/Annie.md')).toBe(false);
});
