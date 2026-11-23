import { readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #2wjvk3br (@kaktuzz's "my deleted blocks come back"): another program
 * (a sync tool, an editor, `touch`) rewrites the open page with the same
 * bytes. Before, every later save was a false "changed on disk" until a
 * restart, so a deleted block came back. Now the edit simply saves.
 */
for (const how of ['rewrite', 'touch'] as const) {
  test(`an outside same-bytes ${how} of the open page: deleting a block afterwards saves, and stays deleted`, async ({ page, vault }) => {
    await vault.seed([{ title: 'Blocks', content: 'Keep this.\n\nDelete this block.\n\nKeep that.' }]);
    const file = path.join(E2E_VAULT, 'Blocks.md');
    await page.goto('/#/Blocks');
    await expect(page.getByTestId('editor-content')).toContainText('Delete this block.');

    // Another program: the same bytes again, or only the time.
    if (how === 'rewrite') await writeFile(file, await readFile(file));
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    // Past the watcher's refresh and the app's disk poll.
    await page.waitForTimeout(2_500);

    // Delete the middle block.
    await page.getByTestId('editor-content').getByText('Delete this block.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await expect(page.getByTestId('conflict-keep-mine')).toHaveCount(0);
    await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).not.toContain('Delete this block.');

    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Keep that.');
    await expect(page.getByTestId('editor-content')).not.toContainText('Delete this block.');
  });
}

test('a real outside edit while typing is still a "changed on disk" conflict', async ({ page, vault }) => {
  await vault.seed([{ title: 'Blocks', content: 'Keep this.' }]);
  const file = path.join(E2E_VAULT, 'Blocks.md');
  await page.goto('/#/Blocks');
  await expect(page.getByTestId('editor-content')).toContainText('Keep this.');
  await page.getByTestId('editor-content').getByText('Keep this.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mine');
  // Before the autosave goes out, another program writes other bytes.
  await writeFile(file, (await readFile(file, 'utf8')).replace('Keep this.', 'Written elsewhere.'));
  const later = new Date(Date.now() + 5_000);
  await utimes(file, later, later);
  await page.keyboard.type(' and more.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict', { timeout: 15_000 });
  expect(await readFile(file, 'utf8')).toContain('Written elsewhere.');
});
