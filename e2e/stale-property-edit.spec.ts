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

/**
 * #bs6j2kzv: the case above waits for the server to have read the outside value, which on 0.9.x means waiting for
 * the watcher's rescan. Here the cell's save is sent before the watcher has caught up (the outside write lands
 * between typing and Enter), the moment a real user hits: the save must still be refused and the outside value
 * stay. The server's answer is checked too.
 */
test('a table cell edit sent right after another app changed that property, before the watcher caught up, never overwrites it', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request, FILES);
  await page.goto('/#/Crew.base');
  await expect(page.getByTestId('base-cell-Crew/Ann-note.role')).toHaveText('Cook');
  await page.route('**/api/bases/**/view**', () => undefined);

  await page.getByTestId('base-cell-Crew/Ann-note.role').click();
  const input = page.getByTestId('base-cell-editor-Crew/Ann-note.role').locator('input');
  await input.fill('Baker');
  // Another app saves Ann now: same size, the file time put back.
  const ann = path.join(E2E_VAULT, 'Crew/Ann.md');
  const { atime, mtime } = await fs.stat(ann);
  await fs.writeFile(ann, '---\nrole: Chef\n---\nAnn\n', 'utf8');
  await fs.utimes(ann, atime, mtime);
  // What the server holds just before the save goes out (@opus-editor): "Cook" means this run hit the window
  // before the watcher caught up; "Chef" means it didn't (then it's the first case again), shown in the message.
  const serverHad = ((await api.getPage(request, 'Crew/Ann')) as { properties?: Array<{ key: string; value: unknown }> }).properties?.find((p) => p.key === 'role')?.value;
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/api/pages/'));
  await input.press('Enter');
  const answer = await saved;
  await page.waitForTimeout(1500);
  expect(await read('Crew/Ann.md'), `the outside value stays (the save answered ${answer.status()}; server had: ${String(serverHad)})`).toBe('---\nrole: Chef\n---\nAnn\n');
  expect(answer.status(), `server had: ${String(serverHad)}`).toBe(409);
});

