import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #959nz9nr (visual QA pass 9, @lead): an error about what you just did (here a refused undo in a database table)
 * belongs to that page. It stayed across the app as a red banner after you went elsewhere (the Trash, another page),
 * where it read as being about that page. Opening another page clears it. Invented content.
 */

const FILES: Record<string, string> = {
  'Team.base':
    'gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n      - age\n',
  'Team/Avery.md': '---\nrole: Cook\nage: 30\n---\nAvery\n',
  'Team/Blake.md': '---\nrole: Pilot\nage: 41\n---\nBlake\n',
  'Notes.md': 'A plain page.\n',
};

test('a refused undo\'s error goes when you open another page', async ({ page, request, vault }) => {
  void vault;
  for (const [relative, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, relative)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, relative), content, 'utf8');
  }
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Team/Blake')).toBe(true);
  await page.goto(`/#/${encodeURIComponent('Team.base')}`);
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Avery', 'Blake']);

  // Delete a property from all rows, then another app edits a row: the undo is refused, naming it.
  await page.getByTestId('base-th-note.role').click();
  await page.getByTestId('base-delete-column').click();
  await page.getByTestId('base-delete-column-dialog-confirm').click();
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Team/Blake.md'), 'utf8')).toBe('---\nage: 41\n---\nBlake\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Team/Blake.md'), '---\nage: 42\n---\nBlake, changed in another app.\n', 'utf8');
  await expect.poll(async () => (await api.getPage(request, 'Team/Blake')).content).toContain('changed in another app');
  await page.keyboard.press('ControlOrMeta+z');
  const banner = page.locator('.banner-error[role="alert"]');
  await expect(banner).toContainText("Can't undo: these rows changed since: Blake.");

  // Another page, opened in the app (not a reload, which would clear it anyway): the error was about the table.
  await page.getByTestId('page-item-Notes').click();
  await page.getByTestId('editor-content').waitFor();
  await expect(banner).toHaveCount(0);
});
