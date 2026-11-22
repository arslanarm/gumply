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

test('#6imze6ux: a tags string Obsidian won\'t read is flagged; "Make it a list" fixes only those lines; digits are flagged without a fix', async ({ page, request, vault }) => {
  void vault;
  const STRING = '---\ntags: five, six # mine\nstatus: draft\n---\n\nBody.\n';
  const DIGITS = '---\ntags: [2024, ok]\n---\n\nBody.\n';
  await fs.writeFile(path.join(E2E_VAULT, 'Str.md'), STRING, 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'Digits.md'), DIGITS, 'utf8');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toEqual(expect.arrayContaining(['Str', 'Digits']));

  await page.goto('/#/Digits');
  const digitsFlag = page.getByTestId('property-issue-tags-digits');
  await expect(digitsFlag).toBeVisible();
  await expect(digitsFlag).toHaveAttribute('title', "Obsidian doesn't count tags made only of digits.");
  await expect(page.getByTestId('property-make-list')).toHaveCount(0);
  await expect(page.getByTestId('property-chip-2024')).toHaveClass(/is-not-tag/);
  await expect(page.getByTestId('property-chip-ok')).not.toHaveClass(/is-not-tag/);

  await page.goto('/#/Str');
  const flag = page.getByTestId('property-issue-tags-string');
  await expect(flag).toBeVisible();
  // The row shows the two tags Gumply reads (not one "five, six" chip), and the header doesn't repeat them.
  const row = page.getByTestId('property-value-tags');
  await expect(row.locator('.property-chip')).toHaveText(['#five', '#six']);
  await expect(page.locator('.page-tag', { hasText: '#five' })).toHaveCount(0);
  await expect(page.locator('.page-tag', { hasText: '#six' })).toHaveCount(0);
  await expect(flag.locator('.property-mismatch')).toHaveAttribute('title', "Obsidian won't read these as tags. Make it a list");
  // The flag carries the tooltip as the digits flag does; the button is described by it (keyboard, screen readers).
  await expect(flag).toHaveAttribute('title', "Obsidian won't read these as tags. Make it a list");
  await expect(page.getByTestId('property-make-list')).toHaveAccessibleDescription("Obsidian won't read these as tags. Make it a list");
  // The specific flag replaces the generic "doesn't match the type" one.
  await expect(page.getByTestId('property-mismatch')).toHaveCount(0);
  // Nothing is written just by opening.
  expect(await fs.readFile(path.join(E2E_VAULT, 'Str.md'), 'utf8')).toBe(STRING);
  expect(await fs.readFile(path.join(E2E_VAULT, 'Digits.md'), 'utf8')).toBe(DIGITS);

  await page.getByTestId('property-make-list').click();
  await expect(flag).toHaveCount(0);
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Str.md'), 'utf8')).toBe('---\ntags: # mine\n  - five\n  - six\nstatus: draft\n---\n\nBody.\n');
});

test('#6imze6ux: removing a chip from a tags string writes a list of the rest; nothing else changes', async ({ page, request, vault }) => {
  void vault;
  const STRING = '---\ntags: five, six # mine\nstatus: draft\n---\n\nBody.\n';
  await fs.writeFile(path.join(E2E_VAULT, 'Str.md'), STRING, 'utf8');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Str');
  await page.goto('/#/Str');
  const row = page.getByTestId('property-value-tags');
  await expect(row.locator('.property-chip')).toHaveText(['#five', '#six']);
  // A user edit: turning the string into a list is fine; only the tags lines change.
  await row.getByTestId('property-chip-five').getByRole('button').click();
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Str.md'), 'utf8')).toBe('---\ntags: # mine\n  - six\nstatus: draft\n---\n\nBody.\n');
  await expect(row.locator('.property-chip')).toHaveText(['#six']);
  await expect(page.getByTestId('property-issue-tags-string')).toHaveCount(0);
});
