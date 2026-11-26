import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #5q4vaacm (from #faqr8pj9's hunt, findings 1 and 4): keyboard data safety in a database grid.
 * (1) Tab in a cell's editor (opened by a click) commits **and moves**, as typing over an active cell already does;
 *     before, it stayed on the cell, so the next typed value overwrote the one just entered.
 * (4) A rename from the grid is a table undo step: Cmd/Ctrl+Z renames the row back (links follow, as for any rename),
 *     and is refused, named, when the old name is taken meanwhile.
 * Synthetic vault.
 */

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');
const exists = (relative: string) => fs.access(path.join(E2E_VAULT, relative)).then(() => true, () => false);

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
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n      - age\n',
  'People/Ann.md': '---\nrole: Cook\nage: 30\n---\nAnn\n',
  'People/Bo.md': '---\nrole: Pilot\nage: 41\n---\nBo\n',
};

async function openPeople(page: Page, names: string[]) {
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(names);
}

const cellOf = (page: Page, rowId: string, key: string) => page.getByTestId(`base-row-${rowId}`).locator(`[data-grid-col]`).nth(key === 'role' ? 1 : 2);

test('Tab in a cell editor opened by a click commits and moves right; Shift+Tab left; Tab past the last column goes to the next row (finding 1)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  const active = page.getByTestId('base-grid-cell');

  // Click Ann's role (its editor opens), type, Tab: the value is saved and the age cell is next.
  await cellOf(page, 'People/Ann', 'role').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Chef');
  await page.keyboard.press('Tab');
  await expect(active).toHaveAttribute('data-active', /^People\/Ann\|.*age$/);
  // Typing now goes into age, never back over role.
  await page.keyboard.type('31');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toBe('---\nrole: Chef\nage: 31\n---\nAnn\n');

  // Shift+Tab from Bo's age editor: saved, and the role cell is next.
  await cellOf(page, 'People/Bo', 'age').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('42');
  await page.keyboard.press('Shift+Tab');
  await expect(active).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Pilot\nage: 42\n---\nBo\n');

  // Tab from Ann's age editor (the last column) goes on to Bo's first cell.
  await cellOf(page, 'People/Ann', 'age').click();
  await page.keyboard.press('Tab');
  await expect(active).toHaveAttribute('data-active', /^People\/Bo\|file\.name$/);
  expect(await read('People/Ann.md')).toBe('---\nrole: Chef\nage: 31\n---\nAnn\n');
});

test('a rename typed on the Name cell is undone by Cmd/Ctrl+Z, links following back; redo renames again (finding 4)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, { ...PEOPLE, 'Notes.md': '# Notes\n\nAsk [[Ann]] about lunch.\n' });
  await openPeople(page, ['Ann', 'Bo']);
  const undo = (shift = false) => page.keyboard.press(`ControlOrMeta+${shift ? 'Shift+' : ''}KeyZ`);

  // Ann's role cell active, one ArrowLeft onto Name, then typing: a rename.
  await cellOf(page, 'People/Ann', 'role').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('base-grid-cell')).toHaveAttribute('data-active', /^People\/Ann\|file\.name$/);
  await page.keyboard.type('Annie');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists('People/Annie.md')).toBe(true);
  await expect.poll(() => read('Notes.md')).toContain('[[Annie]]');

  await page.getByTestId('base-table').click({ position: { x: 5, y: 5 } });
  await undo();
  await expect.poll(() => exists('People/Ann.md')).toBe(true);
  expect(await exists('People/Annie.md')).toBe(false);
  expect(await read('People/Ann.md')).toBe(PEOPLE['People/Ann.md']);
  await expect.poll(() => read('Notes.md')).toContain('[[Ann]]');
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);

  await undo(true);
  await expect.poll(() => exists('People/Annie.md')).toBe(true);
  await expect.poll(() => read('Notes.md')).toContain('[[Annie]]');
});

test('undoing a grid rename is refused, named, when the old name is taken meanwhile; nothing is renamed (finding 4)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);

  await cellOf(page, 'People/Ann', 'role').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Annie');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists('People/Annie.md')).toBe(true);

  // Another app makes a new "Ann" in the folder.
  await fs.writeFile(path.join(E2E_VAULT, 'People/Ann.md'), '---\nrole: Baker\n---\nA different Ann.\n', 'utf8');
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'People/Ann'), { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Annie', 'Bo']);

  await page.getByTestId('base-table').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect(page.getByRole('alert')).toContainText('Ann');
  expect(await exists('People/Annie.md')).toBe(true);
  expect(await read('People/Ann.md')).toBe('---\nrole: Baker\n---\nA different Ann.\n');
  expect(await exists('People/Ann 2.md')).toBe(false);
});
