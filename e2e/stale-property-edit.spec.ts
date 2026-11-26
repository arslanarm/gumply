import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #vqm6gqpu (found by #dqdwz9qw's replay): another app changes only a property, at the same size and
 * with the file time put back. A table cell edit from the version the view loaded must not overwrite
 * it (D22): the cell's save is refused and the outside value stays. Synthetic vault.
 */

test.describe.configure({ timeout: 60_000 });

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

async function writeVault(request: APIRequestContext, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  const ids = Object.keys(files).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

const FILES = {
  'Crew.base': 'filters:\n  and:\n    - file.inFolder("Crew")\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n',
  'Crew/Ann.md': '---\nrole: Cook\n---\nAnn\n',
  'Crew/Bo.md': '---\nrole: Pilot\n---\nBo\n',
};

test('a table cell edit after another app changed that property (same size, time put back) never overwrites it', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, FILES);
  await page.goto('/#/Crew.base');
  await expect(page.getByTestId('base-cell-Crew/Ann-note.role')).toHaveText('Cook');

  // The table keeps the versions it loaded (its refreshes are held); then another app edits Ann.
  await page.route('**/api/bases/**/view**', () => undefined);
  const ann = path.join(E2E_VAULT, 'Crew/Ann.md');
  const { atime, mtime } = await fs.stat(ann);
  await fs.writeFile(ann, '---\nrole: Chef\n---\nAnn\n', 'utf8');
  await fs.utimes(ann, atime, mtime);
  // The server has read it.
  await expect
    .poll(async () => ((await api.getPage(request, 'Crew/Ann')) as { properties?: Array<{ key: string; value: unknown }> }).properties?.find((p) => p.key === 'role')?.value, { timeout: 10_000 })
    .toBe('Chef');

  // The user edits the cell they still see as "Cook".
  await page.getByTestId('base-cell-Crew/Ann-note.role').click();
  const input = page.getByTestId('base-cell-editor-Crew/Ann-note.role').locator('input');
  await input.fill('Baker');
  await input.press('Enter');
  await page.waitForTimeout(2000);
  expect(await read('Crew/Ann.md'), 'the outside value stays').toBe('---\nrole: Chef\n---\nAnn\n');
});
