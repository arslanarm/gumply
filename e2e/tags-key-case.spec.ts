import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #ippqkgus (D39): a `Tags:` key (any case) is the page's tags, as in
 * Obsidian 1.14.4. The Tags pane lists it, the property shows tag chips, and
 * an edit elsewhere keeps the file byte-exact.
 */

const CAPS = '---\nTags: [capT]\nstatus: draft # mine\n---\n\nBody of the note.\n\nTarget paragraph.\n';

test('a `Tags:` note is in the Tags pane, shows tag chips, and stays byte-exact', async ({ page, request, vault }) => {
  void vault;
  await fs.writeFile(path.join(E2E_VAULT, 'Caps.md'), CAPS, 'utf8');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Caps');
  await page.goto('/#/Caps');
  await expect(page.getByTestId('editor-content')).toContainText('Target paragraph.');

  // The property keeps its spelling and shows as tags.
  const chip = page.getByTestId('property-value-Tags').getByTestId('property-chip-capT');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/is-tag/);

  await page.getByTestId('tags-pane-toggle').click();
  await expect(page.getByTestId('tag-count-capT')).toHaveText('1');

  // A far edit: only that line changes.
  await page.getByTestId('editor-content').getByText('Target paragraph.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  expect(await fs.readFile(path.join(E2E_VAULT, 'Caps.md'), 'utf8')).toBe(CAPS.replace('Target paragraph.', 'Target paragraph. X'));
});
