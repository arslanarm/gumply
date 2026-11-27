import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #5n2yvfjy (@graph-dev's nit 3 on #12): Escape in a list (chip) editor cancels the typed draft, as it does in the
 * text and number editors: nothing is added, in a database cell or a page's properties panel. An Escape that ends an
 * IME composition only ends the composition. Synthetic vault.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

const ANN = '---\nrole: Cook\nskills:\n  - bread\n---\nAnn\n';
const FILES = {
  'People.base':
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - skills\n',
  'People/Ann.md': ANN,
  '.gumply/types.json': '{\n  "types": {\n    "skills": "multitext"\n  }\n}\n',
};

test('Escape in a database list cell cancels the typed item: nothing is added, the cell stays active', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, FILES);
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann']);
  await page.getByTestId('base-row-People/Ann').locator('[data-grid-col]').nth(1).click();
  const input = page.getByTestId('base-cell-editor-People/Ann-note.skills').locator('input.property-chip-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('pies');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-grid-cell')).toBeFocused();
  await page.waitForTimeout(800);
  expect(await read('People/Ann.md')).toBe(ANN);
});

test('Escape in a page\'s list property cancels the typed item and leaves the field; an IME Escape only ends the composition', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, FILES);
  await page.goto('/#/People/Ann');
  const input = page.getByTestId('property-value-skills').locator('input.property-chip-input');
  await input.click();
  await input.fill('pies');
  // The Escape a composition ends with: the draft stays, the field keeps the focus.
  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('pies');
  // A plain Escape cancels: the draft is gone, the field is left, nothing is written.
  await page.keyboard.press('Escape');
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue('');
  await page.waitForTimeout(800);
  expect(await read('People/Ann.md')).toBe(ANN);
  // Typing and Enter still adds, as before.
  await input.click();
  await input.fill('pies');
  await input.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toContain('  - pies\n');
});
