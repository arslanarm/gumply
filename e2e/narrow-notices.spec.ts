import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { listPages } from './support/api';
import { E2E_VAULT } from './support/env';

/**
 * #qq6xe2f2 (visual QA): on a narrow window (a phone, a split screen) the notices keep a readable
 * width. The toast used `left: 50%` with a shrink-to-fit width, so it got half the window and
 * wrapped its text a word per line; the conflict banner squeezed its text beside the buttons.
 * Invented content.
 */
test.use({ viewport: { width: 420, height: 800 } });

test('the rename notice (ru, the longest string) spans the narrow window, not half of it', async ({ page, vault }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await vault.seed([{ title: 'Plan', content: 'Intro.\n\nMe: [[Plan]] here.\n' }]);
  // The title PUT is held, so the editing lands during the rename. #z9hufufn: typing the rename's
  // rewrite can carry over is taken in place (no notice), so this deletes the self-link's line: that
  // can't be merged whole, and the reload keeps the typing in History, with the notice.
  await page.route(
    (url) => url.pathname === '/api/pages/Plan',
    async (route) => {
      const sent = route.request();
      if (sent.method() === 'PUT' && (sent.postDataJSON() as { title?: string } | null)?.title !== undefined) await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    },
  );
  await page.goto('/#/Plan');
  await expect(page.getByTestId('editor-content')).toContainText('Intro.');
  await page.getByTestId('page-title').click();
  await page.getByTestId('page-title-input').fill('Plan 2');
  await page.getByTestId('page-title-input').press('Enter');
  await page.getByTestId('editor-content').getByText('here.').click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.getByTestId('editor-content').getByText('Intro.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  const notice = page.getByTestId('undo-toast');
  await notice.waitFor({ timeout: 15_000 });
  await notice.hover(); // pauses its timer while it is measured
  await expect(notice).toContainText('Набранный во время переименования текст сохранён в Истории.');
  const box = (await notice.boundingBox())!;
  expect(box.width, 'the toast uses the window, not half of it').toBeGreaterThan(330);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(420);
  // At most two lines of text (a word per line was 4+ lines).
  expect(box.height).toBeLessThan(70);
  const button = notice.getByRole('button', { name: 'История' });
  const buttonBox = (await button.boundingBox())!;
  expect(buttonBox.height, 'the button label stays on one line').toBeLessThan(30);
});

test('a conflict banner keeps its text readable; its buttons wrap under it', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Note', content: 'Mine.' }]);
  const copy = 'Note (копия с компьютера Laptop)';
  await writeFile(path.join(E2E_VAULT, `${copy}.md`), 'Their text.\n', 'utf8');
  await expect.poll(async () => (await listPages(request)).some((p) => p.id === copy), { timeout: 10_000 }).toBe(true);
  await page.goto('/#/Note');
  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toContainText('This page has a conflicting copy from Yandex Disk.');
  const text = (await banner.locator(':scope > span:not(.conflict-banner-actions)').boundingBox())!;
  const actions = (await banner.locator('.conflict-banner-actions').boundingBox())!;
  expect(text.width, 'the text is not squeezed beside the buttons').toBeGreaterThan(250);
  expect(actions.y, 'the buttons sit under the text').toBeGreaterThanOrEqual(text.y + text.height - 1);
});
