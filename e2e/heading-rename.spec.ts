import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 C2 (#u84ebtf3): renaming a heading in the editor rewrites
 * `[[Page#Old]]`, `[[Page#Old|alias]]` and `![[Page#Old]]` in the other files,
 * byte for byte, and leaves files with no matching link alone.
 */

const file = (name: string) => path.join(E2E_VAULT, name);
const DAILY = 'C2 Daily.md';
const DAILY_TEXT = 'Obsidian note: [[Roadmap#Goals]] stays CRLF.\r\n';

test.afterEach(async () => {
  await rm(file(DAILY), { force: true });
});

test('renaming a heading rewrites the links to it in other files', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Roadmap', content: '## Goals\n\nShip it.\n\n## Risks\n\nNone.\n' },
    { title: 'Notes', content: 'See [[Roadmap#Goals]] and [[Roadmap#Goals|the goals]].\n\n![[Roadmap#Goals]]\n' },
    { title: 'Other', content: 'Only [[Roadmap#Risks]] here.\n' },
  ]);
  await writeFile(file(DAILY), DAILY_TEXT);
  const otherBefore = await readFile(file('Other.md'), 'utf8');
  // Let the server's watcher index the Obsidian note.
  await expect.poll(async () => (await vault.pages()).some((meta) => meta.title === 'C2 Daily'), { timeout: 5_000 }).toBe(true);

  await page.goto(`/#/${encodeURIComponent('Roadmap')}`);
  const heading = page.getByTestId('editor-content').getByRole('heading', { name: 'Goals' });
  await expect(heading).toBeVisible();
  await heading.dblclick();
  await page.keyboard.type('Objectives');
  await expect(page.getByTestId('editor-content').getByRole('heading', { name: 'Objectives' })).toBeVisible();

  const notesBody = async () => (await readFile(file('Notes.md'), 'utf8')).replace(/^---\n[\s\S]*?\n---\n\n?/, '');
  await expect
    .poll(notesBody, { timeout: 5_000 })
    .toBe('See [[Roadmap#Objectives]] and [[Roadmap#Objectives|the goals]].\n\n![[Roadmap#Objectives]]\n');
  await expect.poll(() => readFile(file(DAILY), 'utf8'), { timeout: 5_000 }).toBe('Obsidian note: [[Roadmap#Objectives]] stays CRLF.\r\n');
  expect(await readFile(file('Other.md'), 'utf8')).toBe(otherBefore);
});
