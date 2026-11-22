import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #5r8k77fe: a plain `[[Page#` lists the page's headings (as `![[Page#`
 * does), `[[#` lists the open note's own headings, and Create never offers a
 * title with `#`.
 */

const file = (name: string) => path.join(E2E_VAULT, name);

async function savedContent(page: Page, request: APIRequestContext, id: string): Promise<string> {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  return (await (await request.get(`${API_URL}/api/pages/${encodeURIComponent(id)}`)).json()).content as string;
}

test('[[Page# lists its headings; picking one writes [[Page#Heading]]', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Target', content: '## Goals\n\nText.\n\n## Risks\n\nMore.\n' }]);
  const [note] = await vault.seed([{ title: 'Note', content: '' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Note');

  await page.getByTestId('editor-content').click();
  await page.keyboard.type('[[Target#');
  const menu = page.getByTestId('link-menu');
  await expect(menu.getByRole('option', { name: 'Goals' })).toBeVisible();
  await expect(menu.getByRole('option', { name: 'Risks' })).toBeVisible();
  // No "Whole page" row for a plain link, and never Create “Target#”.
  await expect(menu.getByRole('option')).toHaveCount(2);
  await expect(page.getByTestId('link-suggestion-create')).toHaveCount(0);

  await page.keyboard.type('Ri');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);

  expect(await savedContent(page, request, note!.id)).toBe('[[Target#Risks]]\n');
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

  expect(await savedContent(page, request, note!.id)).toBe('## Alpha\n\nFirst. See [[#Alpha]]\n');
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
  expect(await savedContent(page, request, note!.id)).toBe('[[Nope#H]]\n');
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
