import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #bg7c9bzk (#faqr8pj9's P3s): adding a property with Enter in the "+" popover leaves the keyboard on the new
 * column's header, not on the page body (a keyboard user had to Tab from the top again). Synthetic vault.
 */

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''));
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id), { timeout: 10_000 }).toEqual(expect.arrayContaining(ids));
}

const BOOKS = {
  'Books.base': 'gumply:\n  rows: Books\nfilters:\n  and:\n    - file.folder == "Books"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
  'Books/Dune.md': '---\ncreated: 2026-01-01T00:00:00.000Z\n---\nDune\n',
};

test('"+" → a name → Enter: the keyboard is on the new column\'s header (#bg7c9bzk)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, BOOKS);
  await page.goto('/#/Books.base');
  await expect(page.getByTestId('base-table')).toBeVisible();
  await page.getByTestId('base-add-column-button').click();
  await page.getByTestId('base-add-column-name').fill('Author');
  await page.getByTestId('base-add-column-name').press('Enter');
  await expect(page.getByTestId('base-add-column')).toHaveCount(0);
  await expect(page.getByTestId('base-th-note.Author')).toBeFocused();
});
