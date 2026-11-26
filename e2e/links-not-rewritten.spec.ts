import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #bbh3n5p7: a rename that can't update the links in a read-only page says so.
 * The read-only page keeps its bytes; the notice names it, in en and ru.
 * Root ignores file modes, so this runs only as a normal user. Synthetic vault.
 */

test.describe.configure({ timeout: 60_000 });
test.skip(typeof process.getuid === 'function' && process.getuid() === 0, 'root ignores file modes');

for (const language of ['en', 'ru'] as const) {
  test(`renaming a page whose links are in a read-only page (${language}): the notice names it, its bytes are kept`, async ({ page, vault }) => {
    if (language === 'ru') await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    await vault.seed([
      { title: 'Hub', content: 'Centre.' },
      { title: 'Notes', content: 'See [[Hub]].' },
      { title: 'Daily', content: 'Today: [[Hub]].' },
    ]);
    const notes = path.join(E2E_VAULT, 'Notes.md');
    const before = await readFile(notes, 'utf8');
    await chmod(notes, 0o444);
    try {
      await page.goto('/#/Daily');
      await page.getByTestId('page-item-Hub').hover();
      await page.getByTestId('page-menu-button-Hub').click();
      await page.getByTestId('rename-page-Hub').click();
      await page.getByTestId('page-rename-input-Hub').fill('Hub renamed');
      await page.keyboard.press('Enter');
      const toast = page.getByTestId('undo-toast');
      await expect(toast).toContainText(language === 'en' ? "Links in 1 page weren't updated" : 'Ссылки в 1 странице не обновлены', { timeout: 15_000 });
      await expect(toast).toContainText('Notes');
      expect(await readFile(notes, 'utf8')).toBe(before);
      await expect.poll(() => readFile(path.join(E2E_VAULT, 'Daily.md'), 'utf8')).toContain('[[Hub renamed]]');
    } finally {
      await chmod(notes, 0o644);
    }
  });
}
