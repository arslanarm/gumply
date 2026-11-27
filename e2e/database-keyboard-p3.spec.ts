import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #qchedmun (from #5n2yvfjy's re-hunt, R3–R5): the database grid's keyboard, three P3s.
 * R3: in "+", Enter on a type adds the property (Space only picks it).
 * R4: Back after opening a row (Ctrl/Cmd+Enter) returns to the table with that row's cell active and focused.
 * R5: Ctrl/Cmd+Enter inside an open cell editor commits, then opens the row (a rename first, then the renamed row).
 * Synthetic vault.
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

const PEOPLE = {
  'People.base':
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n',
  'People/Ann.md': '---\nrole: Cook\n---\nAnn\n',
  'People/Bo.md': '---\nrole: Pilot\n---\nBo\n',
};

async function openPeople(page: Page) {
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
}

test('R3: in "+", Space on a type only picks it; Enter on a type adds the property', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  await page.getByTestId('base-add-column-button').click();
  await page.getByTestId('base-add-column-name').fill('year');
  const number = page.getByTestId('base-add-column-type-number');
  await number.focus();
  await page.keyboard.press('Space');
  await expect(number).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('base-add-column')).toBeVisible();
  expect(await read('People.base')).not.toContain('year');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('base-add-column')).toHaveCount(0);
  await expect.poll(() => read('People.base')).toContain('      - year\n');
  await expect(page.getByTestId('base-th-note.year')).toBeVisible();
});

test('R4: Back after Ctrl/Cmd+Enter opened a row: the table has that row\'s cell active and focused', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  await page.getByTestId('base-add-column-button').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('base-grid-cell')).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/#\/People\/Bo$/);
  await page.goBack();
  await expect(page).toHaveURL(/People\.base/);
  const cell = page.getByTestId('base-grid-cell');
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);

  // A fresh visit (the sidebar, not Back) starts with no active cell.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/#\/People\/Bo$/);
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  await expect(page.getByTestId('base-grid-cell')).toHaveCount(0);
});

test('R5: Ctrl/Cmd+Enter in an open editor commits, then opens the row; in the Name editor it renames first, then opens the renamed row', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  // A value editor.
  await page.getByTestId('base-row-People/Bo').locator('[data-grid-col]').nth(1).click();
  const editor = page.getByTestId('base-cell-editor-People/Bo-note.role').locator('input').first();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Diver');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/#\/People\/Bo$/);
  // The page opens on the saved value (the open waited for the save), so typing there is no conflict (@graph-dev).
  await expect(page.getByTestId('property-value-role').locator('input')).toHaveValue('Diver');
  await expect.poll(() => read('People/Bo.md')).toContain('role: Diver\n');
  await page.getByTestId('editor-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Flies.');
  await expect.poll(() => read('People/Bo.md'), { timeout: 15_000 }).toContain('Flies.');
  await expect(page.getByTestId('conflict-keep-mine')).toHaveCount(0);

  // The Name editor: renamed first, then the row opens under its new name.
  await page.goBack();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);
  // Back restored Bo's role as the active cell (R4); up and left reach Ann's Name.
  await expect(page.getByTestId('base-grid-cell')).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('base-grid-cell')).toHaveAttribute('data-active', /^People\/Ann\|file\.name$/);
  await page.keyboard.press('Enter');
  const title = page.getByTestId('base-title-input-People/Ann');
  await expect(title).toBeFocused();
  await title.fill('Annie');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/#\/People\/Annie$/);
  await expect.poll(() => fs.access(path.join(E2E_VAULT, 'People/Annie.md')).then(() => true, () => false)).toBe(true);
});

test('R5: when the save is refused, Ctrl/Cmd+Enter stays on the table with the error, so the user can retry (@graph-dev, @lead)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  // Bo's next save is refused (as a change made elsewhere meanwhile would be).
  await page.route(/\/api\/pages\/People(%2F|\/)Bo$/, async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Bo changed on disk' }) });
    else await route.fallback();
  });
  await page.getByTestId('base-row-People/Bo').locator('[data-grid-col]').nth(1).click();
  const editor = page.getByTestId('base-cell-editor-People/Bo-note.role').locator('input').first();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Diver');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page).toHaveURL(/People\.base/);
  await expect(page.getByTestId('base-table')).toBeVisible();
  expect(await read('People/Bo.md')).toBe(PEOPLE['People/Bo.md']);
});
