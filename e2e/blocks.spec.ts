import { test, expect } from './fixtures';

/**
 * Q1a Notion-style blocks (spec/q1-quality): hover gutter, block menu,
 * turn-into, insert and drag-reorder with persistence.
 */
test.describe('block gutter and menu', () => {
  test('hovering a block shows the gutter, + opens the slash menu', async ({ page, vault }) => {
    await vault.seed([{ title: 'Blocks', content: 'Alpha\n\nBeta' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await expect(body).toBeVisible();

    await body.getByText('Alpha', { exact: true }).hover();
    await expect(page.getByTestId('block-gutter')).toBeVisible();
    await expect(page.getByTestId('block-insert')).toBeVisible();
    await expect(page.getByTestId('block-handle')).toBeVisible();

    await page.getByTestId('block-insert').click();
    await expect(page.getByTestId('slash-menu')).toBeVisible();
    await expect(page.getByTestId('slash-menu-item-heading-1')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('slash-menu')).toHaveCount(0);
    await expect(body).toContainText('/');
  });

  test('the block menu turns a paragraph into a heading and it persists', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Turn into', content: 'Alpha\n\nBeta' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    const alpha = body.getByText('Alpha', { exact: true });
    await expect(alpha).toBeVisible();

    await alpha.hover();
    await expect(page.getByTestId('block-gutter')).toBeVisible();
    await page.getByTestId('block-handle').click();

    const menu = page.getByTestId('block-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('block-turn-into-h1')).toBeVisible();
    await expect(page.getByTestId('block-turn-into-todo')).toBeVisible();
    await expect(page.getByTestId('block-menu-item-duplicate')).toBeVisible();
    await expect(page.getByTestId('block-menu-item-delete')).toBeVisible();

    await page.getByTestId('block-turn-into-h1').click();
    await expect(menu).toHaveCount(0);
    await expect(body.locator('h1')).toHaveText('Alpha');

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    await page.reload();
    await expect(page.getByTestId('editor-content').locator('h1')).toHaveText('Alpha');
  });

  test('dragging the handle reorders blocks and the order persists', async ({ page, vault }) => {
    await vault.seed([{ title: 'Drag reorder', content: 'First\n\nSecond\n\nThird' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    const first = body.getByText('First', { exact: true });
    await expect(first).toBeVisible();

    // Hover the block we want to move; the gutter is a single overlay row.
    await body.getByText('Third', { exact: true }).hover();
    const handle = page.getByTestId('block-handle');
    await expect(page.getByTestId('block-gutter')).toBeVisible();

    // Drop it above "First".
    await handle.dragTo(first, { targetPosition: { x: 20, y: 2 } });

    const order = async () =>
      (await page.getByTestId('editor-content').locator('p').allTextContents()).map((text) =>
        text.trim(),
      );
    await expect.poll(order).toEqual(['Third', 'First', 'Second']);

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    await page.reload();
    await expect.poll(order).toEqual(['Third', 'First', 'Second']);
  });
});
