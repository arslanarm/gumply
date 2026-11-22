import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #35e42m7v: with `Target.md` and `Projects/Target.md` in the vault, a bare
 * `[[Target]]` opens the file Obsidian opens: the one in the linking note's
 * own folder, else the shortest path.
 */

const file = (name: string) => path.join(E2E_VAULT, name);

// Written straight into the vault (as Obsidian would); the vault fixture deletes them.
async function seedFiles(vault: { pages(): Promise<Array<{ id: string }>> }) {
  await mkdir(file('Projects'), { recursive: true });
  await writeFile(file('Target.md'), 'The root Target.\n');
  await writeFile(file('Projects/Target.md'), 'The Projects Target.\n');
  await writeFile(file('Projects/A.md'), 'From Projects: [[Target]].\n');
  await writeFile(file('B.md'), 'From the root: [[Target]].\n');
  await expect
    .poll(async () => {
      const ids = (await vault.pages()).map((meta) => meta.id);
      return ['Target', 'Projects/Target', 'Projects/A', 'B'].every((id) => ids.includes(id));
    }, { timeout: 5_000 })
    .toBe(true);
}

test('a click on [[Target]] opens the Target in the linking note\'s folder', async ({ page, vault }) => {
  await seedFiles(vault);

  await page.goto(`/#/${encodeURIComponent('Projects/A')}`);
  const fromProjects = page.getByTestId('editor-content').getByTestId('wiki-link-Projects/Target');
  await expect(fromProjects).toHaveText('Target');
  await fromProjects.click();
  await expect(page.getByTestId('editor-content')).toContainText('The Projects Target.');
  await expect(page).toHaveURL(/#\/Projects\/Target$/);

  await page.goto(`/#/${encodeURIComponent('B')}`);
  const fromRoot = page.getByTestId('editor-content').getByTestId('wiki-link-Target');
  await expect(fromRoot).toHaveText('Target');
  await fromRoot.click();
  await expect(page.getByTestId('editor-content')).toContainText('The root Target.');
});

test('"Linked from" lists each note under the Target it means', async ({ page, vault }) => {
  await seedFiles(vault);
  await page.goto(`/#/${encodeURIComponent('Projects/Target')}`);
  await expect(page.getByTestId('backlink-Projects/A')).toBeVisible();
  await expect(page.getByTestId('backlink-B')).toHaveCount(0);
  await page.goto(`/#/${encodeURIComponent('Target')}`);
  await expect(page.getByTestId('backlink-B')).toBeVisible();
  await expect(page.getByTestId('backlink-Projects/A')).toHaveCount(0);
});
