import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Route } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #3c444g85: a plain note (no frontmatter title) renamed outside Gumply, e.g.
 * by Obsidian, while it's open. The open editor follows it to the new name
 * instead of showing "This page doesn't exist", keeping focus, and unsaved
 * text saves to the new file.
 */

const file = (name: string) => path.join(E2E_VAULT, name);
const editor = (page: import('@playwright/test').Page) => page.getByTestId('editor').getByTestId('editor-content');

test('the open editor follows an outside rename of a plain note, with focus kept', async ({ page, request, vault }) => {
  void vault;
  await writeFile(file('Target.md'), 'Some text.\n');
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Target'), { timeout: 10_000 }).toBe(true);
  await page.goto('/#/Target');
  await expectPageTitle(page, 'Target');
  await editor(page).getByText('Some text.').click();
  await expect(editor(page)).toBeFocused();

  await rename(file('Target.md'), file('Renamed Target.md'));
  await expect(page).toHaveURL(/#\/Renamed%20Target$/, { timeout: 10_000 });
  await expectPageTitle(page, 'Renamed Target');
  await expect(page.getByTestId('page-not-found')).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText('Some text.');
});

test('unsaved text survives an outside rename and saves to the new file', async ({ page, request, vault }) => {
  void vault;
  await writeFile(file('Draft.md'), 'Start.\n');
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Draft'), { timeout: 10_000 }).toBe(true);
  await page.goto('/#/Draft');
  await expectPageTitle(page, 'Draft');

  // Hold the editor's saves, so the typed text is still unsaved when the file is renamed.
  const held: Route[] = [];
  let holding = true;
  await page.route('**/api/pages/**', (route) => (holding && route.request().method() === 'PUT' ? void held.push(route) : route.continue()));
  await editor(page).getByText('Start.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed while it moved.');
  await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThan(0);

  await rename(file('Draft.md'), file('Moved draft.md'));
  await expect(page).toHaveURL(/#\/Moved%20draft$/, { timeout: 10_000 });
  await expect(page.getByTestId('deleted-on-disk-banner')).toHaveCount(0);
  await expect(editor(page)).toHaveText('Start. Typed while it moved.');

  // Let the saves through: the text lands in the renamed file (the old id redirects to it).
  holding = false;
  for (const route of held.splice(0)) await route.continue();
  await expect.poll(() => readFile(file('Moved draft.md'), 'utf8'), { timeout: 10_000 }).toContain('Start. Typed while it moved.');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).not.toContain('Draft');
});
