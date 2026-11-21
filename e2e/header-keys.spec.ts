import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/** #vi74zw3s: editing an Obsidian note never adds updated:/created:/title:. */

test('an edit in the editor changes only the body of an Obsidian note with frontmatter, twice', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
  const file = path.join(E2E_VAULT, 'Draft.md');
  await fs.writeFile(file, '---\nstatus: draft\ntags: [x]\n---\nObsidian body.\n');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Draft');
  await page.goto('/#/Draft');
  const body = page.getByTestId('editor-content');
  await body.getByText('Obsidian body.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' E.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  expect(await fs.readFile(file, 'utf8')).toBe('---\nstatus: draft\ntags: [x]\n---\nObsidian body. E.\n');
  // A second save goes through with the version the first one returned (no conflict).
  await page.keyboard.type(' F.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  expect(await fs.readFile(file, 'utf8')).toBe('---\nstatus: draft\ntags: [x]\n---\nObsidian body. E. F.\n');
});
