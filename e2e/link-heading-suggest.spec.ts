import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #5r8k77fe: a plain `[[Page#` lists the page's headings (as `![[Page#`
 * does), `[[#` lists the open note's own headings, and Create never offers a
 * title with `#`.
 */

const file = (name: string) => path.join(E2E_VAULT, name);

/**
 * The page's content on disk, polled until it's `expected` (#9jrdufrh). Waiting for
 * `save-status` = saved isn't enough: right after an edit it can still show the
 * previous save's "saved" (React renders the new state a task later), so a
 * single read could see the file before the last edit is written.
 */
async function expectSaved(request: APIRequestContext, id: string, expected: string): Promise<void> {
  await expect
    .poll(async () => (await (await request.get(`${API_URL}/api/pages/${encodeURIComponent(id)}`)).json()).content as string, { timeout: 10_000 })
    .toBe(expected);
}

test('[[Page# lists its headings; picking one writes [[Page#Heading]]', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Target', content: '## Goals\n\nText.\n\n## Risks\n\nMore.\n' }]);
  const [note] = await vault.seed([{ title: 'Note', content: '' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');

  await page.getByTestId('editor-content').click();
  await page.keyboard.type('[[Target#');
  const menu = page.getByTestId('link-menu');
  // #9jrdufrh: the headings come from a fetch of Target (one per keystroke after
  // `#`), then a render; under full-suite load that can take longer than the
  // default 5 s expect timeout. Same wait on state, with room for the load.
  const loaded = { timeout: 15_000 };
  await expect(menu.getByRole('option', { name: 'Goals' })).toBeVisible(loaded);
  await expect(menu.getByRole('option', { name: 'Risks' })).toBeVisible(loaded);
  // No "Whole page" row for a plain link, and never Create “Target#”.
  await expect(menu.getByRole('option')).toHaveCount(2);
  await expect(page.getByTestId('link-suggestion-create')).toHaveCount(0);

  await page.keyboard.type('Ri');
  await expect(menu.getByRole('option')).toHaveCount(1, loaded);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);

  await expectSaved(request, note!.id, '[[Target#Risks]]');
  expect((await vault.pages()).some((meta) => meta.title.includes('#'))).toBe(false);
});

test('[[# lists the open note\'s own headings and writes [[#Heading]]', async ({ page, vault, request }) => {
  const [note] = await vault.seed([{ title: 'Note', content: '## Alpha\n\nFirst.\n' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');

  await page.getByTestId('editor-content').getByText('First.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' See [[#');
  const menu = page.getByTestId('link-menu');
  await expect(menu.getByRole('option', { name: 'Alpha' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);

  await expectSaved(request, note!.id, '## Alpha\n\nFirst. See [[#Alpha]]');
});

test('[[Nope#H offers Create “Nope”, and the link keeps #H', async ({ page, vault, request }) => {
  const [note] = await vault.seed([{ title: 'Note', content: '' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');

  await page.getByTestId('editor-content').click();
  await page.keyboard.type('[[Nope#H');
  const create = page.getByTestId('link-suggestion-create');
  await expect(create).toContainText('Nope');
  await expect(create).not.toContainText('#');
  await create.click();

  await expect.poll(async () => (await vault.pages()).map((meta) => meta.title)).toContain('Nope');
  await expectSaved(request, note!.id, '[[Nope#H]]');
});

test('with two pages of the same name, the headings come from the one in the note\'s folder', async ({ page, vault }) => {
  // Written straight into the vault; the vault fixture deletes them.
  await mkdir(file('Projects/Sub'), { recursive: true });
  await mkdir(file('Other'), { recursive: true });
  await writeFile(file('Projects/Sub/Three.md'), '## Sub heading\n\nUnder Projects.\n');
  await writeFile(file('Other/Three.md'), '## Other heading\n\nIn Other.\n');
  await writeFile(file('Projects/Pick.md'), '');
  await expect
    .poll(async () => {
      const ids = new Set((await vault.pages()).map((meta) => meta.id));
      return ['Projects/Sub/Three', 'Other/Three', 'Projects/Pick'].every((id) => ids.has(id));
    }, { timeout: 5_000 })
    .toBe(true);

  await page.goto(`/#/${encodeURIComponent('Projects/Pick')}`);
  await page.getByTestId('editor-content').click();
  await page.keyboard.type('[[Three#');
  const menu = page.getByTestId('link-menu');
  await expect(menu.getByRole('option', { name: 'Sub heading' })).toBeVisible();
  await expect(menu.getByRole('option', { name: 'Other heading' })).toHaveCount(0);
});
