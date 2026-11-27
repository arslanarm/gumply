import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #hazfav7a: a rename the user types into a name that's taken (any letter case) is refused with a clear message, and
 * the old name stays: it used to make "Pantry 2.md" titled "Pantry", two items that look the same. From the title
 * field (the typed body is kept, the focus isn't lost), the sidebar, and a database's Name cell. A case-only rename
 * of the same page is still allowed. Synthetic vault.
 */

const exists = (relative: string) => fs.access(path.join(E2E_VAULT, relative)).then(() => true, () => false);

test('the title field: refused with a message, the title goes back, and the body typed meanwhile is saved', async ({ page, request, vault }) => {
  await vault.seed([{ title: 'Pantry', content: 'Shelves.' }, { title: 'Notes', content: 'Body.' }]);
  await page.goto('/#/Notes');
  await expect(page.getByTestId('editor-content')).toHaveText('Body.');
  await page.getByTestId('page-title').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Pantry');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('A page called “Pantry” is already here');
  await expect(page.getByTestId('page-title')).toHaveText('Notes');
  // Typing in the body goes on, and is saved under the old name.
  await page.getByTestId('editor-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' More.');
  await expect.poll(async () => (await api.getPage(request, 'Notes')).content, { timeout: 8_000 }).toContain('Body. More.');
  expect(await exists('Pantry 2.md')).toBe(false);
  await expect(page.getByTestId('page-item-Notes')).toBeVisible();
});

test('the sidebar rename: refused, in another letter case too; the item keeps its name', async ({ page, vault }) => {
  await vault.seed([{ title: 'Pantry', content: 'Shelves.' }, { title: 'Notes', content: 'Body.' }]);
  await page.goto('/#/Notes');
  await expect(page.getByTestId('editor-content')).toHaveText('Body.');
  await page.getByTestId('page-item-Notes').hover();
  await page.getByTestId('page-menu-button-Notes').click();
  await page.getByTestId('rename-page-Notes').click();
  await page.getByTestId('page-rename-input-Notes').fill('pantry');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('already here');
  await expect(page.getByTestId('page-item-Notes')).toBeVisible();
  expect(await exists('pantry 2.md')).toBe(false);
  expect(await exists('Notes.md')).toBe(true);
});

test('a database Name cell: refused, the row keeps its name; and ru says it in Russian', async ({ page, request, vault }) => {
  void vault;
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await fs.mkdir(path.join(E2E_VAULT, 'People'), { recursive: true });
  await fs.writeFile(
    path.join(E2E_VAULT, 'People.base'),
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
    'utf8',
  );
  await fs.writeFile(path.join(E2E_VAULT, 'People', 'Ann.md'), 'Ann\n', 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'People', 'Bo.md'), 'Bo\n', 'utf8');
  await expect.poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('People/')).length, { timeout: 10_000 }).toBe(2);
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  await page.locator('[data-row-id="People/Bo"] .base-cell-edit').click();
  await page.getByTestId('base-title-input-People/Bo').fill('Ann');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Ann' })).toContainText('уже');
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  expect(await exists('People/Ann 2.md')).toBe(false);
});

test('a case-only rename of the same page is still allowed', async ({ page, vault }) => {
  await vault.seed([{ title: 'pantry', content: 'Shelves.' }]);
  await page.goto('/#/pantry');
  await expect(page.getByTestId('editor-content')).toHaveText('Shelves.');
  await page.getByTestId('page-title').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Pantry');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('page-item-Pantry')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
