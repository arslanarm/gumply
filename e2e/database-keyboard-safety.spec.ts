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
/** Click a cell and wait until its editor has opened and holds the focus (keys sent before that go elsewhere). */
async function openEditor(page: Page, rowId: string, key: string) {
  await cellOf(page, rowId, key).click();
  await expect(page.getByTestId(`base-cell-editor-${rowId}-note.${key}`).locator('input').first()).toBeFocused();
}

test('Tab in a cell editor opened by a click commits and moves right; Shift+Tab left; Tab past the last column goes to the next row (finding 1)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page, ['Ann', 'Bo']);
  const active = page.getByTestId('base-grid-cell');

  // Click Ann's role (its editor opens), type, Tab: the value is saved and the age cell is next.
  await openEditor(page, 'People/Ann', 'role');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Chef');
  await page.keyboard.press('Tab');
  await expect(active).toHaveAttribute('data-active', /^People\/Ann\|.*age$/);
  // Typing now goes into age, never back over role.
  await page.keyboard.type('31');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toBe('---\nrole: Chef\nage: 31\n---\nAnn\n');

  // Shift+Tab from Bo's age editor: saved, and the role cell is next.
  await openEditor(page, 'People/Bo', 'age');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('42');
  await page.keyboard.press('Shift+Tab');
  await expect(active).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Pilot\nage: 42\n---\nBo\n');

  // Tab from Ann's age editor (the last column) goes on to Bo's first cell.
  await openEditor(page, 'People/Ann', 'age');
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
  await openEditor(page, 'People/Ann', 'role');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-grid-cell')).toBeFocused();
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

  await openEditor(page, 'People/Ann', 'role');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-grid-cell')).toBeFocused();
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

test('Enter in a text or number editor opened by a click commits and moves down; a Select picker\'s Enter picks and stays (finding 1, spec §4)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, {
    ...PEOPLE,
    'People.base': PEOPLE['People.base'].replace('      - age\n', '      - age\n      - status\nproperties:\n  note.status:\n    gumplyType: select\n    gumplyOptions:\n      - value: Busy\n        color: red\n      - value: Free\n        color: green\n'),
  });
  await openPeople(page, ['Ann', 'Bo']);
  const active = page.getByTestId('base-grid-cell');

  // Ann's role editor: type, Enter: saved, and Bo's role is next.
  await openEditor(page, 'People/Ann', 'role');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Chef');
  await page.keyboard.press('Enter');
  await expect(active).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await expect.poll(() => read('People/Ann.md')).toContain('role: Chef\n');
  // Typing goes into Bo's role, never back over Ann's.
  await page.keyboard.type('Diver');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toContain('role: Diver\n');
  expect(await read('People/Ann.md')).toContain('role: Chef\n');

  // Ann's status picker: type, Enter picks the match; the cell stays active (Notion), nothing moves down.
  await page.getByTestId('base-row-People/Ann').locator('[data-grid-col]').nth(3).click();
  await expect(page.getByTestId('base-select-picker')).toBeVisible();
  await page.keyboard.type('Fr');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Ann.md')).toContain('status: Free\n');
  await expect(page.getByTestId('base-select-picker')).toHaveCount(0);
  await expect(active).toHaveAttribute('data-active', /^People\/Ann\|.*status$/);
  expect(await read('People/Bo.md')).not.toContain('status');
});

test('undoing a grid rename while the row is open in another tab: that tab follows to the old name, and its next save goes there (finding 4, @lead)', async ({ page, context, request, vault }) => {
  void vault;
  await writeVault(request, { ...PEOPLE, 'People/Ann.md': '---\nrole: Cook\nage: 30\n---\nAnn likes soup.\n' });
  const other = await context.newPage();
  await other.goto('/#/People/Ann');
  await expect(other.getByTestId('editor-content')).toContainText('Ann likes soup.');

  await openPeople(page, ['Ann', 'Bo']);
  await openEditor(page, 'People/Ann', 'role');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-grid-cell')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Annie');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists('People/Annie.md')).toBe(true);
  await expect(other).toHaveURL(/#\/People\/Annie$/, { timeout: 15_000 });

  await page.getByTestId('base-table').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(() => exists('People/Ann.md')).toBe(true);
  await expect(other).toHaveURL(/#\/People\/Ann$/, { timeout: 15_000 });

  // The other tab types on: the text lands in Ann.md, and no Annie.md comes back.
  await other.getByTestId('editor-content').getByText('Ann likes soup.').click();
  await other.keyboard.press('End');
  await other.keyboard.type(' And bread.');
  await expect.poll(() => read('People/Ann.md'), { timeout: 15_000 }).toContain('Ann likes soup. And bread.');
  expect(await exists('People/Annie.md')).toBe(false);
  await other.close();
});

test('Tab inside a datetime cell\'s date picker moves inside the picker and reaches its time field; it doesn\'t leave the cell (@graph-dev\'s review)', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, {
    ...PEOPLE,
    'People.base': PEOPLE['People.base'].replace('      - age\n', '      - age\n      - due\n'),
    'People/Ann.md': '---\nrole: Cook\nage: 30\ndue: 2026-03-02T10:30\n---\nAnn\n',
    '.gumply/types.json': '{\n  "types": {\n    "due": "datetime"\n  }\n}\n',
  });
  await openPeople(page, ['Ann', 'Bo']);
  await page.getByTestId('base-row-People/Ann').locator('[data-grid-col]').nth(3).click();
  const editor = page.getByTestId('base-cell-editor-People/Ann-note.due');
  await expect(editor).toBeVisible();
  const picker = page.getByTestId('date-picker');
  if (!(await picker.isVisible())) await editor.getByTestId('date-picker-value').click();
  await expect(picker).toBeVisible();
  await picker.getByTestId('date-picker-day-2026-03-02').focus();
  const time = picker.getByTestId('date-picker-time');
  for (let i = 0; i < 8 && !(await time.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(time).toBeFocused();
  await expect(picker).toBeVisible();
  // Nothing left the cell meanwhile: its editor is still open, and the value is as it was.
  await expect(editor).toBeVisible();
  expect(await read('People/Ann.md')).toContain('due: 2026-03-02T10:30\n');
});
