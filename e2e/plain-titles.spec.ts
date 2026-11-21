import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/** #bayuasqq: a plain note's title is its file name verbatim, as in Obsidian. */

const FILES = {
  'meeting-notes.md': 'Notes body\n',
  'my_page.md': 'Page body\n',
  'Projects/q1-roadmap.md': 'Roadmap\n',
};

test('an Obsidian vault shows its file names as titles; editing renames nothing', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
  for (const [relative, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, relative)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, relative), text);
  }
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Projects/q1-roadmap');

  await page.goto('/#/meeting-notes');
  await expect(page.getByTestId('page-title')).toHaveText('meeting-notes');
  await expect(page.getByTestId('page-item-meeting-notes')).toContainText('meeting-notes');
  await expect(page.getByTestId('page-item-my_page')).toContainText('my_page');

  const body = page.getByTestId('editor-content');
  await body.getByText('Notes body', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  expect(await fs.readFile(path.join(E2E_VAULT, 'meeting-notes.md'), 'utf8')).toBe('Notes body edited\n');
  const names = (await fs.readdir(E2E_VAULT)).filter((name) => name.endsWith('.md')).sort();
  expect(names).toEqual(['meeting-notes.md', 'my_page.md']);

  // Cmd+K: "meeting notes" (spaces) finds meeting-notes first.
  await page.keyboard.press('Control+k');
  await page.getByTestId('quick-switcher-input').fill('meeting notes');
  await expect(page.getByTestId('quick-switcher').getByRole('option').first()).toHaveAttribute(
    'data-testid',
    'search-result-meeting-notes',
  );
});
