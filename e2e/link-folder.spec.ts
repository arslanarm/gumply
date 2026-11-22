import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #35e42m7v: a click on a bare link opens the file Obsidian 1.14.4 opens
 * (@opus-hunter's measured table): a whole vault path first, then a same-named
 * page under the linking note's folder (any depth), then the shortest path.
 */

const file = (name: string) => path.join(E2E_VAULT, name);

// Written straight into the vault (as Obsidian would); the vault fixture deletes them.
const FILES: Record<string, string> = {
  'Target.md': 'The root Target.\n',
  'Projects/Target.md': 'The Projects Target.\n',
  'Projects/Sub/Target.md': 'The Projects/Sub Target.\n',
  'Projects/Sub/Three.md': 'Three under Projects.\n',
  'Other/Three.md': 'Three in Other.\n',
  'Other/Two.md': 'Two in Other.\n',
  'Alpha/Two.md': 'Two in Alpha.\n',
  'Projects/A.md': 'From Projects: [[Target]] and [[Three]].\n',
  'Other/C.md': 'From Other: [[Two]] and [[Three]].\n',
};

async function seedFiles(vault: { pages(): Promise<Array<{ id: string }>> }) {
  for (const [name, body] of Object.entries(FILES)) {
    await mkdir(path.dirname(file(name)), { recursive: true });
    await writeFile(file(name), body);
  }
  const ids = Object.keys(FILES).map((name) => name.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const have = new Set((await vault.pages()).map((meta) => meta.id));
      return ids.every((id) => have.has(id));
    }, { timeout: 5_000 })
    .toBe(true);
}

async function follow(page: Page, from: string, link: string, opens: string, text: string) {
  await page.goto(`/#/${encodeURIComponent(from)}`);
  const anchor = page.getByTestId('editor-content').getByTestId(`wiki-link-${opens}`);
  await expect(anchor).toHaveText(link);
  await anchor.click();
  await expect(page.getByTestId('editor-content')).toContainText(text);
  await expect(page).toHaveURL(new RegExp(`#/${opens.replace(/\//g, '\\/')}$`));
}

test('clicks open the file Obsidian opens (#35e42m7v)', async ({ page, vault }) => {
  await seedFiles(vault);
  // A whole vault path wins outright: the root Target, even from Projects/.
  await follow(page, 'Projects/A', 'Target', 'Target', 'The root Target.');
  // Under the note's folder at any depth beats the shorter Other/Three.
  await follow(page, 'Projects/A', 'Three', 'Projects/Sub/Three', 'Three under Projects.');
  // In the note's own folder beats the alphabetically first Alpha/Two.
  await follow(page, 'Other/C', 'Two', 'Other/Two', 'Two in Other.');
  await follow(page, 'Other/C', 'Three', 'Other/Three', 'Three in Other.');
});

test('"Linked from" lists each note under the page its link means', async ({ page, vault }) => {
  await seedFiles(vault);
  await page.goto(`/#/${encodeURIComponent('Projects/Sub/Three')}`);
  await expect(page.getByTestId('backlink-Projects/A')).toBeVisible();
  await expect(page.getByTestId('backlink-Other/C')).toHaveCount(0);
  await page.goto(`/#/${encodeURIComponent('Other/Three')}`);
  await expect(page.getByTestId('backlink-Other/C')).toBeVisible();
  await expect(page.getByTestId('backlink-Projects/A')).toHaveCount(0);
  await page.goto(`/#/${encodeURIComponent('Projects/Target')}`);
  await expect(page.getByTestId('backlink-Projects/A')).toHaveCount(0);
});
