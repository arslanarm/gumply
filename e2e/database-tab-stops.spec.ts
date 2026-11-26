import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #12 of #faqr8pj9's hunt (in #bg7c9bzk, taken with #5q4vaacm): a database grid's rows are **one** Tab stop. Tab from
 * "+" reaches the rows once (the first row's Name, or the active cell), and the next Tab goes on to the typing row.
 * Inside, arrows and Tab move; Ctrl/Cmd+Enter opens the active row; Escape on a cell that isn't being edited leaves
 * the grid for the typing row, while Escape in an editor first only cancels the edit. Synthetic vault.
 */

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
  'People/Cy.md': '---\nrole: Diver\nage: 25\n---\nCy\n',
};

async function openPeople(page: Page) {
  await page.goto('/');
  await page.getByTestId('page-item-People.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Ann', 'Bo', 'Cy']);
}

test('the rows are one Tab stop: from "+" one Tab reaches the first row\'s Name, the next the typing row; Shift+Tab back', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  const grid = page.getByTestId('base-grid-cell');

  await page.getByTestId('base-add-column-button').focus();
  await page.keyboard.press('Tab');
  await expect(grid).toBeFocused();
  await expect(grid).toHaveAttribute('data-active', /^People\/Ann\|file\.name$/);

  // Escape leaves the grid for the typing row (Tab inside the grid moves cells, as in a spreadsheet).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-typing-input')).toBeFocused();

  // Back with Shift+Tab: one stop, the grid again, at the cell that was active.
  await page.keyboard.press('Shift+Tab');
  await expect(grid).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('base-add-column-button')).toBeFocused();

  // No cell or row button of the table is a Tab stop of its own.
  const stops = await page.getByTestId('base-table-scroll').evaluate((table) =>
    [...table.querySelectorAll<HTMLElement>('button, [tabindex], input')].filter(
      (element) => element.tabIndex >= 0 && !element.closest('.base-table-head') && element.dataset.testid !== 'base-typing-input' && element.dataset.testid !== 'base-grid-cell',
    ).length,
  );
  expect(stops).toBe(0);
});

test('Ctrl/Cmd+Enter on any cell of a row opens that row\'s page', async ({ page, request, vault }) => {
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
  await expect(page.getByTestId('editor-content')).toContainText('Bo');
});

test('Escape in a cell editor only cancels the edit (the cell stays active); a second Escape leaves the grid', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, PEOPLE);
  await openPeople(page);
  const grid = page.getByTestId('base-grid-cell');
  await page.getByTestId('base-add-column-button').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const editor = page.getByTestId('base-cell-editor-People/Ann-note.role').locator('input').first();
  await expect(editor).toBeFocused();
  await page.keyboard.type('Baker');
  await page.keyboard.press('Escape');
  await expect(grid).toBeFocused();
  await expect(grid).toHaveAttribute('data-active', /^People\/Ann\|.*role$/);
  expect(await fs.readFile(path.join(E2E_VAULT, 'People/Ann.md'), 'utf8')).toBe(PEOPLE['People/Ann.md']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('base-typing-input')).toBeFocused();
});
