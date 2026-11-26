import { chmod, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #bajn9rna: a page whose file is read-only on disk (chmod 444, set by the
 * user or another tool) is never replaced. Typing stays in the editor, the save
 * status says "Read-only file" (not the generic "Couldn't save"), the file keeps
 * its bytes and mode, and it saves by itself once the file is writable again.
 * Root ignores file modes, so this runs only as a normal user. Synthetic vault.
 */

test.describe.configure({ timeout: 60_000 });
test.skip(typeof process.getuid === 'function' && process.getuid() === 0, 'root ignores file modes');

const file = path.join(E2E_VAULT, 'Ledger.md');

for (const language of ['en', 'ru'] as const) {
  test(`a read-only page file (${language}): "Read-only file", the typing kept, nothing written; it saves once writable`, async ({ page, vault }) => {
    if (language === 'ru') await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    const [ledger] = await vault.seed([{ title: 'Ledger', content: 'Balance: ten.' }]);
    await page.goto(`/#/${encodeURIComponent(ledger!.id)}`);
    const body = page.getByTestId('editor-content');
    await body.getByText('Balance: ten.').click();
    await page.keyboard.press('End');
    const before = await readFile(file, 'utf8');
    await chmod(file, 0o444);
    try {
      await page.keyboard.type(' Typed while read-only.');
      const status = page.getByTestId('save-status');
      await expect(status).toHaveAttribute('data-state', 'error', { timeout: 10_000 });
      await expect(status).toContainText(language === 'en' ? 'Read-only file' : 'Файл только для чтения');
      await expect(body).toContainText('Typed while read-only.');
      expect(await readFile(file, 'utf8')).toBe(before);
      expect((await stat(file)).mode & 0o777).toBe(0o444);
    } finally {
      await chmod(file, 0o644);
    }
    await expect.poll(() => readFile(file, 'utf8'), { timeout: 20_000 }).toContain('Typed while read-only.');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  });
}
