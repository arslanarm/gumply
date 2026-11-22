import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// Written straight into the vault; the vault fixture deletes them (they're pages).
const SAME_NAME = 'Archive/Roadmap.md';
const LINKS = 'C2 Links.md';
const CARDS = 'C2 Cards.canvas';

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

test('a same-named page elsewhere doesn\'t stop the rewrite; table aliases, escaped links and board cards (#u84ebtf3)', async ({ page, vault }) => {
  await vault.seed([{ title: 'Roadmap', content: '## Goals\n\nShip it.\n' }]);
  await mkdir(file('Archive'), { recursive: true });
  const archive = '## Goals\n\nOld plan.\n';
  await writeFile(file(SAME_NAME), archive);
  await writeFile(
    file(LINKS),
    '| a | [[Roadmap#Goals\\|piped]] |\n| - | - |\n\n[[Roadmap#Goals]] [[Archive/Roadmap#Goals]] \\[[Roadmap#Goals]]\n',
  );
  await writeFile(
    file(CARDS),
    JSON.stringify({
      nodes: [
        { id: 'r', type: 'file', file: 'Roadmap.md', subpath: '#Goals', x: 0, y: 0, width: 200, height: 100 },
        { id: 'a', type: 'file', file: 'Archive/Roadmap.md', subpath: '#Goals', x: 0, y: 200, width: 200, height: 100 },
      ],
      edges: [],
    }),
  );
  await expect
    .poll(async () => {
      const titles = (await vault.pages()).map((meta) => meta.id);
      return titles.includes('Archive/Roadmap') && titles.includes('C2 Links') && titles.includes('C2 Cards.canvas');
    }, { timeout: 5_000 })
    .toBe(true);

  await page.goto(`/#/${encodeURIComponent('Roadmap')}`);
  const heading = page.getByTestId('editor-content').getByRole('heading', { name: 'Goals' });
  await expect(heading).toBeVisible();
  await heading.dblclick();
  await page.keyboard.type('Objectives');

  await expect
    .poll(() => readFile(file(LINKS), 'utf8'), { timeout: 5_000 })
    .toBe('| a | [[Roadmap#Objectives\\|piped]] |\n| - | - |\n\n[[Roadmap#Objectives]] [[Archive/Roadmap#Goals]] \\[[Roadmap#Goals]]\n');
  const cards = JSON.parse(await readFile(file(CARDS), 'utf8')) as { nodes: Array<{ id: string; subpath: string }> };
  expect(cards.nodes.map((node) => [node.id, node.subpath])).toEqual([
    ['r', '#Objectives'],
    ['a', '#Goals'],
  ]);
  expect(await readFile(file(SAME_NAME), 'utf8')).toBe(archive);
});
