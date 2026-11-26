import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #kwqfr693 (visual QA 7): on a narrow window the page's own actions (Outline, Local graph,
 * rename, …) lay over the right half of the title. Hidden, they were only transparent, so a tap on
 * the title hit an invisible Outline button instead of starting a rename; shown (on focus), they
 * covered the end of the name being typed (a new database's "Untitled database", any rename).
 * They have their own row under the title now. Invented content.
 */
test.use({ viewport: { width: 420, height: 800 } });

const TITLE = 'A rather long page title for a phone';

async function overlapping(page: Page): Promise<string[]> {
  const field = (await page.getByTestId('page-title').boundingBox())!;
  return page.evaluate(({ x, y, width, height }) => {
    return Array.from(document.querySelectorAll<HTMLElement>('.page-header-actions button'))
      .filter((button) => {
        const box = button.getBoundingClientRect();
        return box.right > x && box.left < x + width && box.bottom > y && box.top < y + height;
      })
      .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '');
  }, field);
}

for (const where of ['middle', 'right end'] as const) {
  test(`a tap on the title's ${where} starts a rename; no page action lies over the title`, async ({ page, vault }) => {
    await vault.seed([{ title: TITLE, content: 'Text.' }]);
    await page.goto(`/#/${encodeURIComponent(TITLE)}`);
    await page.getByTestId('editor-content').waitFor();
    const title = page.getByTestId('page-title');
    expect(await overlapping(page), 'nothing lies over the title before editing').toEqual([]);
    const box = (await title.boundingBox())!;
    const x = where === 'middle' ? box.width / 2 : box.width - 12;
    await title.click({ position: { x, y: box.height / 2 }, timeout: 3_000 });
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    expect(await overlapping(page), 'nothing lies over the title while it is edited').toEqual([]);
    await page.keyboard.press('Escape');
  });
}

test('on a narrow window the page actions are visible without hover, and work', async ({ page, vault }) => {
  await vault.seed([{ title: TITLE, content: 'Text.' }]);
  await page.goto(`/#/${encodeURIComponent(TITLE)}`);
  await page.getByTestId('editor-content').waitFor();
  await page.mouse.move(400, 780); // away from the heading: a phone has no hover
  await expect(page.locator('.page-header-actions')).toHaveCSS('opacity', '1');
  await page.getByTestId('outline-toggle').click({ timeout: 3_000 });
  await expect(page.getByTestId('right-panel-tab-outline')).toHaveAttribute('aria-selected', 'true');
});
