import { expect, test, type Page } from '@playwright/test';

/**
 * Level of detail (#bdzcggf5): far zoomed out, text that would be about 4px
 * or less on screen is drawn as placeholder bars; shapes, colours, card
 * outlines and connectors stay, and real text comes back once legible.
 * Driven through the board lab with a remembered view (zoom) per board.
 */

async function openAt(page: Page, zoom: number, id: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, JSON.stringify({ x: 60, y: 40, zoom: value })),
    [`gumply:board-view:lab:${id}`, zoom] as const,
  );
  await page.goto(`/board-lab.html?seed=60&mix=1&id=${id}`);
  await page.waitForSelector('.react-flow__node');
  await expect(page.getByTestId('board')).toHaveAttribute('data-lod', /\d/);
}

/** Whether a sticky's text is really painted (vs. drawn as bars). */
const stickyTextVisible = (page: Page) =>
  page
    .getByTestId('board-sticky')
    .first()
    .locator('.board-text > *')
    .first()
    .evaluate((element) => getComputedStyle(element).visibility === 'visible');

test.describe('board level of detail (#bdzcggf5)', () => {
  test('at 15% zoom text is drawn as bars; shapes, colours and connectors stay', async ({ page }) => {
    await openAt(page, 0.15, `lod15-${Date.now()}`);
    const board = page.getByTestId('board');
    expect(Number(await board.getAttribute('data-lod'))).toBeGreaterThanOrEqual(4);
    expect(await stickyTextVisible(page)).toBe(false);
    // The bars are the text box's own background.
    const bars = await page
      .getByTestId('board-sticky')
      .first()
      .locator('.board-text')
      .evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(bars).toContain('gradient');
    // Colours and outlines stay.
    const colour = await page
      .getByTestId('board-sticky')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(colour).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.locator('.react-flow__edge').first()).toBeVisible();
  });

  test('at 40% zoom text is real and legible', async ({ page }) => {
    await openAt(page, 0.4, `lod40-${Date.now()}`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-lod', '0');
    expect(await stickyTextVisible(page)).toBe(true);
    await expect(page.getByTestId('board-sticky').first()).toContainText('Sticky 0');
  });

  test('zooming in brings text back; selecting and editing work while zoomed out', async ({ page }) => {
    await openAt(page, 0.15, `lodedit-${Date.now()}`);
    const sticky = page.getByTestId('board-sticky').first();
    const box = (await sticky.boundingBox())!;

    // Select at 15%: a click on the sticky selects it.
    await page.mouse.click(box.x + 4, box.y + 4);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    // Edit at 15%: the editor shows the real text, and typing saves.
    await page.mouse.dblclick(box.x + 4, box.y + 4);
    const editor = page.getByTestId('board-text-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(/Sticky 0/);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' LOD');
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __board: { serialized: () => string } }).__board.serialized(),
        ),
      )
      .toContain('LOD');

    // Zoom in past the threshold: real text again.
    await page.mouse.click(5, 450);
    // Each click zooms 1.2× with a short animation: wait for each one.
    for (let step = 0; step < 12 && (await page.getByTestId('board').getAttribute('data-lod')) !== '0'; step += 1) {
      await page.getByTestId('board-zoom-in').click();
      await page.waitForTimeout(250);
    }
    await expect(page.getByTestId('board')).toHaveAttribute('data-lod', '0');
    // Real text comes back only once legible: 13px text at least ~4.5px high.
    const zoom = Number(await page.getByTestId('board-zoom-value').innerText().then((text) => parseInt(text, 10))) / 100;
    expect(zoom * 13).toBeGreaterThan(4.4);
    expect(await stickyTextVisible(page)).toBe(true);
  });
});
