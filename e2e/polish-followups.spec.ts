import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #q9t4axad: follow-ups from the #h4jpj2hw hand check.
 * Restore keeps the caret, the narrow top bar fits, the overlay sidebar has a
 * scrim and only closes when the window becomes narrow, toasts use a fitting
 * icon.
 */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

test('Restore page keeps the caret where it was', async ({ page, vault, request }) => {
  const [doc] = await vault.seed([{ title: 'Restorable', content: 'Base line.' }]);
  await page.goto(`/#/${doc!.id}`);
  const editor = page.getByTestId('editor-content');
  await expect(editor).toHaveText('Base line.');

  // Unsaved edits: hold every save so the buffer stays dirty.
  await page.route('**/api/pages/**', (route) =>
    route.request().method() === 'PUT' ? undefined : route.continue(),
  );
  await editor.getByText('Base line.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' unsaved');

  await fs.rm(path.join(E2E_VAULT, `${doc!.id}.md`));
  const banner = page.getByTestId('deleted-on-disk-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  await banner.getByRole('button', { name: 'Restore page' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.ProseMirror')).toBeFocused();

  await page.keyboard.type(' after');
  await waitSaved(page);
  await expect
    .poll(async () => (await api.getPage(request, doc!.id)).content)
    .toBe('Base line. unsaved after');
});

test.describe('narrow window (400px)', () => {
  test.use({ viewport: { width: 400, height: 720 } });

  test('every top-bar control fits on screen', async ({ page, vault }) => {
    const [parent] = await vault.seed([{ title: 'Projects', content: 'Folder' }]);
    const [doc] = await vault.seed([
      { title: 'Quarterly planning notes', content: 'Body', parentId: parent!.id },
    ]);
    await page.goto(`/#/${doc!.id}`);
    await expect(page.getByTestId('editor-content')).toHaveText('Body');

    for (const id of ['sidebar-toggle', 'theme-toggle', 'shortcuts-button']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x, id).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, id).toBeLessThanOrEqual(400);
    }
    // The current page is still named in the top bar.
    await expect(page.locator('.breadcrumb-crumb.is-current')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  });

  test('the overlay sidebar has a scrim; tapping the page closes it', async ({ page, vault }) => {
    const [doc] = await vault.seed([{ title: 'Note', content: 'Body' }]);
    await page.goto(`/#/${doc!.id}`);
    await expect(page.getByTestId('editor-content')).toHaveText('Body');
    // Narrow windows start with the sidebar closed.
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('sidebar-scrim')).toBeHidden();

    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('sidebar-scrim')).toBeVisible();
    await page.mouse.click(370, 400);
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('sidebar-scrim')).toBeHidden();
  });

  test('a resize while narrow keeps an open sidebar; becoming narrow closes it', async ({
    page,
    vault,
  }) => {
    const [doc] = await vault.seed([{ title: 'Note', content: 'Body' }]);
    await page.goto(`/#/${doc!.id}`);
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'true');

    // E.g. a phone keyboard appearing.
    await page.setViewportSize({ width: 400, height: 420 });
    await page.waitForTimeout(100);
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Wide with the sidebar open, then narrow: closed.
    await page.setViewportSize({ width: 1200, height: 720 });
    // Let the resize event for the wide size fire before narrowing again.
    await page.waitForFunction(() =>
      new Promise((resolve) => requestAnimationFrame(() => resolve(window.innerWidth === 1200))),
    );
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});

test('toasts use an icon that fits: bin for delete, arrow for move', async ({ page, vault }) => {
  const [a] = await vault.seed([{ title: 'Alpha', content: 'A' }]);
  const [b] = await vault.seed([{ title: 'Beta', content: 'B' }]);
  await page.goto(`/#/${a!.id}`);
  await expect(page.getByTestId('editor-content')).toHaveText('A');

  await page.getByTestId(`page-menu-button-${b!.id}`).click();
  await page.getByTestId(`move-page-${b!.id}`).click();
  await page.getByRole('dialog').getByText('Alpha', { exact: true }).click();
  const toast = page.getByTestId('undo-toast');
  await expect(toast).toContainText('Moved');
  const moveIcon = await toast.locator('.toast-icon svg').innerHTML();

  await page.getByTestId('undo-delete').click();
  await expect(toast).toHaveCount(0);
  await page.getByTestId(`page-menu-button-${b!.id}`).click();
  await page.getByTestId(`delete-page-${b!.id}`).click();
  await expect(toast).toContainText('Page deleted');
  const deleteIcon = await toast.locator('.toast-icon svg').innerHTML();

  expect(moveIcon).not.toBe(deleteIcon);
});
