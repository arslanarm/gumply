import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * D20 (#73xpk354): file names follow page titles, so a rename changes the
 * page id. The open page must survive that change: no remount, no lost body,
 * no title re-focus, and saves go to the new file.
 */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

const readNote = (id: string) => fs.readFile(path.join(E2E_VAULT, `${id}.md`), 'utf8');
const exists = (id: string) =>
  fs.access(path.join(E2E_VAULT, `${id}.md`)).then(
    () => true,
    () => false,
  );
const hashId = (page: Page) => decodeURIComponent(new URL(page.url()).hash.replace(/^#\//, ''));

test.describe('D20: file names follow titles', () => {
  test('new page → title → Enter → body: nothing is lost after the id changes', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Home', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toContainText('Hello');

    for (const pause of [0, 1500]) {
      const title = `Alpha ${pause}`;
      await page.getByTestId('new-page-button').click();
      await expect(page.getByTestId('page-title-input')).toBeFocused();
      await page.keyboard.type(title, { delay: 20 });
      await page.keyboard.press('Enter');
      if (pause) await page.waitForTimeout(pause);
      await page.keyboard.type('Body text here.', { delay: 40 });

      // The URL follows the new file name while focus stays in the body.
      await expect.poll(() => hashId(page)).toBe(title);
      await page.waitForTimeout(400);
      await expect(page.locator('.ProseMirror')).toBeFocused();
      await expect(page.getByTestId('editor-content')).toHaveText('Body text here.');
      await expect(page.getByTestId('page-title')).toHaveText(title);
      await waitSaved(page);

      expect(await readNote(title)).toContain('Body text here.');
      expect(await exists('Untitled')).toBe(false);
    }

    // Survives a reload.
    await page.reload();
    await expectPageTitle(page, 'Alpha 1500');
    await expect(page.getByTestId('editor-content')).toHaveText('Body text here.');
  });

  test('renaming twice in one session keeps the body and later edits append to it', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Home', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toContainText('Hello');

    await page.getByTestId('new-page-button').click();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('Gamma');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gamma body.');
    await waitSaved(page);
    await expect.poll(() => hashId(page)).toBe('Gamma');

    // Rename via the header: click the title, append " two", Enter.
    await page.getByTestId('page-title').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' two');
    await page.keyboard.press('Enter');

    await expect.poll(() => hashId(page)).toBe('Gamma two');
    await expect(page.getByTestId('editor-content')).toHaveText('Gamma body.');

    await page.keyboard.press('End');
    await page.keyboard.type(' More.');
    await waitSaved(page);

    const note = await readNote('Gamma two');
    expect(note).toContain('Gamma body. More.');
    expect(await exists('Gamma')).toBe(false);
    await expect(page.getByTestId('page-item-Gamma two')).toBeVisible();
  });

  test('renaming the parent of the open page keeps editing the moved child', async ({
    page,
    vault,
    request,
  }) => {
    const [parent] = await vault.seed([{ title: 'Projects', content: 'All projects' }]);
    const [child] = await vault.seed([
      { title: 'Roadmap', content: 'Q1', parentId: parent!.id },
    ]);
    await page.goto(`/#/${child!.id}`);
    await expect(page.getByTestId('editor-content')).toHaveText('Q1');

    // Rename the parent from the sidebar while the child stays open.
    await page.getByTestId(`page-item-${parent!.id}`).hover();
    await page.getByTestId(`page-menu-button-${parent!.id}`).click();
    await page.getByTestId(`rename-page-${parent!.id}`).click();
    await page.getByTestId(`page-rename-input-${parent!.id}`).fill('Work');
    await page.keyboard.press('Enter');

    await expect.poll(() => hashId(page)).toBe('Work/Roadmap');
    await page.getByTestId('editor-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' and Q2');
    await waitSaved(page);

    expect(await readNote('Work/Roadmap')).toContain('Q1 and Q2');
    expect((await api.getPage(request, 'Work/Roadmap')).parentId).toBe('Work');
  });

  test('setting an icon and then typing does not raise a conflict', async ({ page, vault }) => {
    const [doc] = await vault.seed([{ title: 'Iconic', content: 'Start' }]);
    await page.goto(`/#/${doc!.id}`);
    await expect(page.getByTestId('editor-content')).toHaveText('Start');

    await page.getByTestId('page-title').hover();
    await page.getByTestId('page-icon-button').click();
    await page.keyboard.type('rocket');
    await expect(page.locator('.emoji-picker-cell.is-active')).toHaveAttribute('data-emoji', '🚀');
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-icon-large')).toHaveText('🚀');

    await page.getByTestId('editor-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' more');
    await waitSaved(page);
    await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
    expect(await readNote('Iconic')).toContain('Start more');
  });
});
