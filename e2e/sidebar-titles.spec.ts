import { expect, test } from './fixtures';

/**
 * #yw53nria: the hidden ⋯ / + row actions lie over the row's end instead of
 * taking their width, so a long title uses the row's full width until the row
 * is hovered or focused. A pointer over them hovers the row, so they're
 * always shown by the time they can be clicked.
 */

const LONG = 'Customer interviews and research notes from the spring';

interface Geometry {
  rowRight: number;
  titleRight: number;
  truncated: boolean;
  actionsOpacity: string;
  hitAtActions: string;
}

test.describe('sidebar title width (#yw53nria)', () => {
  test.beforeEach(async ({ page, vault }) => {
    await vault.seed([{ title: 'Home', content: 'Home' }, { title: LONG, content: 'Notes' }]);
    await page.goto('/#/Home');
    await expect(page.getByTestId(`page-item-${LONG}`)).toBeVisible();
  });

  async function geometry(page: import('@playwright/test').Page): Promise<Geometry> {
    return page.evaluate((id) => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-page-id]')].find((item) => item.dataset.pageId === id)!;
      const title = row.querySelector<HTMLElement>('.page-item-title')!;
      const actions = row.querySelector<HTMLElement>('.page-actions')!;
      const menu = row.querySelector<HTMLElement>('[data-testid^="page-menu-button-"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(menu.left + menu.width / 2, menu.top + menu.height / 2);
      return {
        rowRight: row.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        truncated: title.scrollWidth > title.clientWidth,
        actionsOpacity: getComputedStyle(actions).opacity,
        hitAtActions: hit?.closest('.page-actions') ? 'actions' : hit?.closest('.page-item') ? 'row' : 'other',
      };
    }, LONG);
  }

  test('a long title runs to the row end while the actions are hidden', async ({ page }) => {
    await page.mouse.move(800, 500);
    const idle = await geometry(page);
    expect(idle.truncated).toBe(true);
    expect(idle.actionsOpacity).toBe('0');
    // Only the row's own padding (0.35rem) is left after the title; the
    // actions used to take ~50-70 px here.
    expect(idle.rowRight - idle.titleRight).toBeLessThan(10);
  });

  test('hover and keyboard focus show the actions, which then take clicks', async ({ page }) => {
    const row = page.getByTestId(`page-item-${LONG}`);
    await row.hover();
    await expect.poll(async () => (await geometry(page)).actionsOpacity).toBe('1');
    expect((await geometry(page)).hitAtActions).toBe('actions');

    await page.getByTestId(`page-menu-button-${LONG}`).click();
    await expect(page.getByTestId(`page-menu-${LONG}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`page-menu-${LONG}`)).toBeHidden();

    await page.mouse.move(800, 500);
    await row.focus();
    await expect.poll(async () => (await geometry(page)).actionsOpacity).toBe('1');
  });
});

test.describe('sidebar look (v0.7 RC audit, for v0.8)', () => {
  test('dark mode: the current row is a neutral tint, not indigo; light keeps the accent', async ({ page, vault }) => {
    await vault.seed([{ title: 'Home', content: 'Home' }, { title: 'Other', content: 'Other' }]);
    const colors = (id: string) =>
      page.getByTestId(`page-item-${id}`).evaluate((row) => {
        const style = getComputedStyle(row);
        return { background: style.backgroundColor, color: style.color };
      });
    const channels = (color: string) => color.match(/\d+/g)!.slice(0, 3).map(Number);

    await page.addInitScript(() => localStorage.setItem('gumply:theme', window.name || 'dark'));
    await page.goto('/#/Home');
    await expect(page.getByTestId('page-item-Home')).toHaveClass(/is-selected/);
    await page.mouse.move(800, 500);
    const dark = await colors('Home');
    const [r, g, b] = channels(dark.background);
    // Grey: the channels within a few steps of each other.
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(4);
    // The same text colour as any other row.
    expect(dark.color).toBe((await colors('Other')).color);

    // Light keeps the accent: indigo text on a lavender fill.
    await page.evaluate(() => {
      window.name = 'light';
    });
    await page.reload();
    await expect(page.getByTestId('page-item-Home')).toHaveClass(/is-selected/);
    await page.mouse.move(800, 500);
    const light = await colors('Home');
    const [lr, , lb] = channels(light.color);
    expect(lb! - lr!).toBeGreaterThan(80);
  });

  test('rows scrolling under the footer fade out', async ({ page, vault }) => {
    await vault.seed(Array.from({ length: 40 }, (_, index) => ({ title: `Note ${String(index).padStart(2, '0')}`, content: 'x' })));
    await page.goto('/#/Note 00');
    await expect(page.getByTestId('page-item-Note 39')).toBeAttached();
    const fade = await page.getByTestId('page-tree').evaluate((tree) => {
      const after = getComputedStyle(tree, '::after');
      return { position: after.position, image: after.backgroundImage };
    });
    expect(fade.position).toBe('sticky');
    expect(fade.image).toContain('linear-gradient');
    // Scrolled to the end, the last row is fully clear of the fade.
    await page.getByTestId('page-tree').evaluate((tree) => tree.scrollTo(0, tree.scrollHeight));
    const clear = await page.getByTestId('page-tree').evaluate((tree) => {
      const row = tree.querySelector('[data-page-id="Note 39"]')!.getBoundingClientRect();
      return tree.getBoundingClientRect().bottom - row.bottom;
    });
    expect(clear).toBeGreaterThanOrEqual(24);
  });
});
