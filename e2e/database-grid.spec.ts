import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #7prbquxu phase 1, step 5 (spec/database-tables §4): a database that owns its rows is a grid. The keyboard
 * moves one active cell; typing into a text or number cell edits it in place and writes only that line; Tab
 * from the typing row makes the row and goes on into its next column; Delete clears; Escape leaves the grid.
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

/** An owned database as New database writes one, with two columns, and two invented rows. */
const PEOPLE = {
  'People.base':
    'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n      - age\n',
  'People/Ann.md': '---\nrole: Cook\nage: 30\n---\nAnn\n',
  'People/Bo.md': '---\nrole: Pilot\nage: 41\n---\nBo\n',
};

test('an owned database is a grid: arrows, typing in place, Tab from the typing row, Delete and Escape', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo']);

  // From the typing row, ArrowUp: the last row's name cell is active and holds the focus.
  const typing = page.getByTestId('base-typing-input');
  await typing.click();
  await typing.press('ArrowUp');
  const cell = page.getByTestId('base-grid-cell');
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|/);

  // Right to "role", type over it, Enter: only the role line changes.
  await page.keyboard.press('ArrowRight');
  await expect(cell).toHaveAttribute('data-active', /^People\/Bo\|.*role$/);
  await page.keyboard.type('Chef');
  await expect(cell).toHaveClass(/is-typing/);
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Bo.md')).toBe('---\nrole: Chef\nage: 41\n---\nBo\n');

  // The typing row: a name and Tab make the row and go on into its "role" cell.
  await typing.click();
  await typing.fill('Cy');
  await typing.press('Tab');
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo', 'Cy']);
  await expect(cell).toHaveAttribute('data-active', /^People\/Cy\|.*role$/);
  await expect(cell).toBeFocused();
  await page.keyboard.type('Diver');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('People/Cy.md')).toMatch(/^---\n[^]*\nrole: Diver\n---\n/);

  // Up to Ann's age, Delete: the value is gone, the rest of the file as it was.
  await typing.click();
  await typing.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(cell).toHaveAttribute('data-active', /^People\/Ann\|.*age$/);
  await page.keyboard.press('Delete');
  await expect.poll(() => read('People/Ann.md')).not.toContain('age: 30');
  expect(await read('People/Ann.md')).toContain('role: Cook\n');

  // Escape leaves the grid.
  await page.keyboard.press('Escape');
  await expect(cell).toHaveCount(0);
});
