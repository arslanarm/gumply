import { expect, test } from './fixtures';

/**
 * #d636gdxx: moving between the title and the body like Notion.
 * Typing straight after Enter must never lose characters.
 */
test.describe('title ↔ body', () => {
  test('keys typed immediately after Enter in a new title land in the body', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Home', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toContainText('Hello');

    for (const delay of [0, 10]) {
      await page.getByTestId('new-page-button').click();
      const title = page.getByTestId('page-title-input');
      await expect(title).toBeFocused();
      await page.keyboard.type(`Race ${delay}`);
      await page.keyboard.press('Enter');
      await page.keyboard.type('XYZ first line', { delay });

      await expect(page.getByTestId('editor-content')).toHaveText('XYZ first line');
      await expect(page.getByTestId('page-title')).toContainText(`Race ${delay}`);
    }
  });

  test('ArrowUp from the first line goes to the title, ArrowDown comes back', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Arrows', content: 'First line\n\nSecond' }]);
    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('Second', { exact: true }).click();

    await page.keyboard.press('ArrowUp'); // into "First line"
    await expect(body).toBeFocused();
    await page.keyboard.press('ArrowUp'); // into the title
    const title = page.getByTestId('page-title-input');
    await expect(title).toBeFocused();
    // Caret at the end, nothing selected (typing must not replace the title).
    expect(await title.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([
      6, 6,
    ]);

    await page.keyboard.press('ArrowDown');
    await expect(body).toBeFocused();
    await page.keyboard.type('>');
    await expect(body.locator('p').first()).toHaveText('>First line');
  });

  test('Backspace in an empty first block goes to the title', async ({ page, vault }) => {
    await vault.seed([{ title: 'Home', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toContainText('Hello');

    await page.getByTestId('new-page-button').click();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('Draft');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-content')).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await expect(page.getByTestId('page-title-input')).toHaveValue('Draft');
  });
});
