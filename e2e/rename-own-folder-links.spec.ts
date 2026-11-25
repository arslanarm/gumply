import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #ekp8ns58: renaming the OPEN page from its title, when its own body links into its sub-page folder
 * (`[[P/Sub]]`). The server rewrites that link to `[[Q/Sub]]`; the editor must not put the old link
 * back with its next save (D37).
 */
test('renaming a parent from its title keeps the rewrite of its own [[P/Sub]] when typing on', async ({ page }) => {
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');

  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');

  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/Moved$/);
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('[[Moved/Sub]]');

  // Type on in the same editor: its save must keep the server's rewrite.
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed after.');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8'), { timeout: 15_000 }).toContain('Typed after.');
  const text = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(text).toContain('[[Moved/Sub]]');
  expect(text).not.toContain('[[Parent/Sub]]');
});
