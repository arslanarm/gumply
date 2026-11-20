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

  test('after editing a title via ArrowUp, the next new page still selects "Untitled"', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Home', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toContainText('Hello');

    let renames = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && (request.postData() ?? '').includes('"title"')) renames += 1;
    });

    await page.getByTestId('new-page-button').click();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('P0');
    await page.keyboard.press('Enter');
    await page.keyboard.type('body');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('!');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Q');
    await expect(page.getByTestId('page-title')).toContainText('P0!');
    // One rename per commit: "P0", then "P0!".
    await expect.poll(() => renames).toBe(2);

    await page.getByTestId('new-page-button').click();
    const title = page.getByTestId('page-title-input');
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('Untitled');
    expect(await title.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 8]);
    await page.keyboard.type('Next');
    await expect(title).toHaveValue('Next');
  });

  test('typing in the title while a rename (D20 id change) is in flight keeps every key', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Home', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toContainText('Hello');

    // Hold title renames for 400ms so the id change lands mid-typing.
    await page.route('**/api/pages/**', async (route) => {
      const request = route.request();
      if (request.method() === 'PUT' && (request.postData() ?? '').includes('"title"')) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await route.continue();
    });

    await page.getByTestId('new-page-button').click();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('Slow');
    await page.keyboard.press('Enter');
    await page.keyboard.type('body');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type(' rename');
    // The first rename ("Slow") resolves now and changes the page id.
    await page.waitForTimeout(600);
    await page.keyboard.type('!');
    await expect(page.getByTestId('page-title-input')).toHaveValue('Slow rename!');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('page-title')).toContainText('Slow rename!');
    await expect(page.getByTestId('editor-content')).toContainText('body');
  });
});

