import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * spec/columns (#d93qerr7): Pandoc fenced-div columns. A recognised row shows
 * as columns and is written back byte for byte when untouched; every near
 * miss stays exactly as it is today (D37, @opus-hunter's fence-div.md).
 */

const file = () => path.join(E2E_VAULT, 'Cols.md');

async function open(page: Page, request: Parameters<typeof api.listPages>[0], text: string) {
  await fs.writeFile(file(), text);
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Cols');
  await page.goto('/#/Cols');
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

async function typeAtEndOf(page: Page, text: string, typed: string) {
  await page.getByTestId('editor-content').getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await saved(page);
}

// @opus-hunter's v0.7.0 baseline: a real row plus every near-miss shape, all byte-exact today.
const FENCE_DIV =
  ':::: {.columns}\n::: {.column width="40%"}\n### Pros\n- Fast\n:::\n::: {.column width="60%"}\nCons text.\n:::\n::::\n\n' +
  '::: note\nA Pandoc-style note div.\n:::\n\n::: {.column}\nA lone column.\n\n:::: {.columns}\nUnclosed fence.\n\n' +
  '```\n::: inside code\n```\n\nText with ::: in the middle.\n\nTarget paragraph.\n';

const SHAPES: Record<string, string> = {
  'two columns, no widths': ':::: {.columns}\n::: {.column}\nLeft\n:::\n::: {.column}\nRight\n:::\n::::',
  'three columns with widths': ':::: {.columns}\n::: {.column width="25%"}\nA\n:::\n::: {.column width="50%"}\nB\n:::\n::: {.column width="25%"}\nC\n:::\n::::',
  'blank lines around the fences': ':::: {.columns}\n\n::: {.column}\n\nLeft\n\n:::\n\n\n::: {.column}\nRight\n:::\n\n::::',
  'touching blocks inside a column': ':::: {.columns}\n::: {.column}\n## Head\nText under it.\n- item\n:::\n::: {.column}\n> [!tip] Tip\n> body\n:::\n::::',
  'code with fences inside a column': ':::: {.columns}\n::: {.column}\n```\n:::\n::::\n```\n:::\n::: {.column}\nB\n:::\n::::',
  'an empty column': ':::: {.columns}\n::: {.column}\n:::\n::: {.column}\nB\n:::\n::::',
  'five colons, bare classes': '::::: columns\n::: column\nA\n:::\n::: column\nB\n:::\n:::::',
  'text right under the row': ':::: {.columns}\n::: {.column}\nA\n:::\n::: {.column}\nB\n:::\n::::\nText right under.',
  // A `:::` right under `> quote` would be a lazy continuation of it (CommonMark): the fences are found
  // before the column is parsed, so the quote ends at the fence (@lead, #ftx3awn7).
  'a quote as a column\'s last block': ':::: {.columns}\n::: {.column}\nA\n> quoted last\n:::\n::: {.column}\n- item last\n:::\n::::',
  'a column with only blank lines': ':::: {.columns}\n::: {.column}\n\n\n:::\n::: {.column}\nB\n:::\n::::',
  'extra attributes, a tab in the braces': ':::: {.columns\t.wide #id}\n::: {.column width="40%" style="x"}\nA\n:::\n::: {.column}\nB\n:::\n::::',
};

// Pandoc's rule (@lead): a row right under a paragraph is not a row; it stays text, byte-exact.
const STAY_TEXT: Record<string, string> = {
  'a row right under a paragraph': 'Above touching.\n:::: {.columns}\n::: {.column}\nA\n:::\n::: {.column}\nB\n:::\n::::',
  'three colons outside': '::: {.columns}\n::: {.column}\nA\n:::\n:::',
};

test.describe('columns (spec/columns)', () => {
  test("@opus-hunter's fence-div.md: the row shows as columns, and the whole file is byte-exact after a far edit", async ({ page, request, vault }) => {
    void vault;
    await open(page, request, FENCE_DIV);
    await expect(page.getByTestId('columns')).toHaveCount(1);
    await expect(page.getByTestId('columns').getByTestId('column')).toHaveCount(2);
    await expect(page.getByTestId('column').first().locator('h3')).toHaveText('Pros');
    await typeAtEndOf(page, 'Target paragraph.', ' X');
    expect(await fs.readFile(file(), 'utf8')).toBe(FENCE_DIV.replace('Target paragraph.', 'Target paragraph. X'));
  });

  for (const [name, shape] of Object.entries(SHAPES)) {
    test(`byte-exact after a far edit: ${name}`, async ({ page, request, vault }) => {
      void vault;
      const text = `${shape}\n\nTarget paragraph.\n`;
      await open(page, request, text);
      await expect(page.getByTestId('columns').first()).toBeVisible();
      await typeAtEndOf(page, 'Target paragraph.', ' X');
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  for (const [name, shape] of Object.entries(STAY_TEXT)) {
    test(`stays text, byte-exact: ${name}`, async ({ page, request, vault }) => {
      void vault;
      const text = `${shape}\n\nTarget paragraph.\n`;
      await open(page, request, text);
      await typeAtEndOf(page, 'Target paragraph.', ' X');
      await expect(page.getByTestId('columns')).toHaveCount(0);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  test('display math in a column renders as a block in both forms, and the file stays byte-exact (#8uqd657j)', async ({ page, request, vault }) => {
    void vault;
    const text = ':::: {.columns}\n::: {.column}\nLeft.\n\n$$\n\\sum_i i\n$$\n:::\n::: {.column}\n$$\\int_0^1 x\\,dx$$\n\n%%\nhidden note\n%%\n:::\n::::\n\nTarget paragraph.\n';
    await open(page, request, text);
    const columns = page.getByTestId('column');
    await expect(columns).toHaveCount(2);
    // Each column holds one display formula (KaTeX), not raw `$$` text or an inline formula with stray `$`.
    for (const column of [columns.first(), columns.nth(1)]) {
      await expect(column.locator('.raw-block-math .katex')).toHaveCount(1);
      await expect(column.locator('.raw-block-math .katex')).toBeVisible();
      await expect(column.locator('.raw-inline-math')).toHaveCount(0);
      expect(await column.locator('p').allTextContents()).not.toContainEqual(expect.stringContaining('$'));
    }
    await typeAtEndOf(page, 'Target paragraph.', ' X');
    expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    // An edit inside the same column leaves the formula's bytes alone.
    await typeAtEndOf(page, 'Left.', ' Y');
    expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X').replace('Left.', 'Left. Y'));
  });

  test('an edit inside one column changes only that line', async ({ page, request, vault }) => {
    void vault;
    const text = `${SHAPES['three columns with widths']}\n\nTarget paragraph.\n`;
    await open(page, request, text);
    await typeAtEndOf(page, 'B', ' edited');
    expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('\nB\n', '\nB edited\n'));
  });

  test('columns sit side by side, in their widths, and stack at 900 px', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, request, `${SHAPES['three columns with widths']}\n`);
    const boxes = async () => Promise.all((await page.getByTestId('column').all()).map(async (column) => (await column.boundingBox())!));
    let [a, b, c] = await boxes();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
    expect(b!.width / a!.width).toBeGreaterThan(1.7);
    expect(Math.abs(c!.width - a!.width)).toBeLessThan(3);
    await page.setViewportSize({ width: 860, height: 800 });
    [a, b, c] = await boxes();
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
    expect(c!.y).toBeGreaterThan(b!.y + b!.height - 1);
  });

  test('stacked, two rows in a row stay two: each row is outlined, with space between (#9j9cd5x4)', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 600, height: 900 });
    const two = SHAPES['two columns, no widths'];
    await open(page, request, `Before.\n\n${two}\n\n${two.replace('Left', 'Second left').replace('Right', 'Second right')}\n\nAfter.\n`);
    const rows = page.locator('.md-columns-wrap');
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      const style = await row.evaluate((element) => {
        const css = getComputedStyle(element);
        return { border: css.borderTopWidth, radius: css.borderTopLeftRadius, left: css.borderLeftWidth };
      });
      // An outline all round (a left bar alone would read as a quote).
      expect(style.border).toBe('1px');
      expect(style.left).toBe('1px');
      expect(parseFloat(style.radius)).toBeGreaterThan(0);
    }
    const [first, second] = [(await rows.nth(0).boundingBox())!, (await rows.nth(1).boundingBox())!];
    expect(second.y - (first.y + first.height)).toBeGreaterThan(6);
    // Side by side again when wide: no outline.
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await rows.first().evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
  });
});

test.describe('making and editing columns (spec/columns §3)', () => {
  const read = () => fs.readFile(file(), 'utf8');

  test('/columns makes a row; the text typed goes in the first column; saved in the canonical shape', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Intro.\n');
    await page.getByTestId('editor-content').getByText('Intro.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/columns');
    await page.getByTestId('slash-menu-item-columns-2').click();
    await expect(page.getByTestId('columns')).toHaveCount(1);
    await expect(page.getByTestId('column')).toHaveCount(2);
    await page.keyboard.type('Left side');
    await saved(page);
    await expect.poll(read).toBe('Intro.\n\n:::: {.columns}\n::: {.column}\nLeft side\n:::\n::: {.column}\n:::\n::::\n');
  });

  test('Turn into → Columns puts the block next to an empty column', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Alpha\n\nBeta\n');
    await page.getByTestId('editor-content').getByText('Alpha', { exact: true }).hover();
    await page.getByTestId('block-handle').click();
    await page.getByTestId('block-menu').getByRole('menuitem', { name: 'Columns' }).click();
    await expect(page.getByTestId('column')).toHaveCount(2);
    await saved(page);
    await expect.poll(read).toBe(':::: {.columns}\n::: {.column}\nAlpha\n:::\n::: {.column}\n:::\n::::\n\nBeta\n');
  });

  test('dragging a block to another block\'s right edge makes a row; dragging it back out dissolves the row', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Alpha\n\nBeta\n\nGamma\n');
    const body = page.getByTestId('editor-content');
    const alpha = body.getByText('Alpha', { exact: true });
    await body.getByText('Gamma', { exact: true }).hover();
    const box = (await alpha.boundingBox())!;
    await page.getByTestId('block-handle').dragTo(alpha, { targetPosition: { x: box.width - 10, y: box.height / 2 } });
    await expect(page.getByTestId('column')).toHaveCount(2);
    await saved(page);
    await expect.poll(read).toBe(':::: {.columns}\n::: {.column}\nAlpha\n:::\n::: {.column}\nGamma\n:::\n::::\n\nBeta\n');

    // Gamma back below Beta: its column empties and goes, and the one column left dissolves.
    await body.getByText('Gamma', { exact: true }).hover();
    const beta = body.getByText('Beta', { exact: true });
    const betaBox = (await beta.boundingBox())!;
    await page.getByTestId('block-handle').dragTo(beta, { targetPosition: { x: 20, y: betaBox.height - 2 } });
    await expect(page.getByTestId('columns')).toHaveCount(0);
    await saved(page);
    await expect.poll(read).toBe('Alpha\n\nBeta\n\nGamma\n');
  });

  test('Mod+Alt+→ moves a block to the next column', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, ':::: {.columns}\n::: {.column}\nOne\n\nTwo\n:::\n::: {.column}\nThree\n:::\n::::\n');
    await page.getByTestId('editor-content').getByText('Two', { exact: true }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+ArrowRight' : 'Control+Alt+ArrowRight');
    await saved(page);
    await expect.poll(read).toBe(':::: {.columns}\n::: {.column}\nOne\n:::\n::: {.column}\nTwo\n\nThree\n:::\n::::\n');
  });

  test('a width next to a bare column lays out 40/60, and an 80 px drag moves the split by about 80 px', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 1280, height: 800 });
    // @opus-hunter's c-attrs shape: one width, one bare column (it laid out 40 against 1 before).
    await open(page, request, ':::: {.columns}\n::: {.column width="40%" style="x"}\nLeft\n:::\n::: {.column}\nRight\n:::\n::::\n');
    const widths = async () => Promise.all((await page.getByTestId('column').all()).map(async (column) => (await column.boundingBox())!.width));
    await expect.poll(async () => {
      const [a, b] = await widths();
      return Math.round((a! / (a! + b!)) * 100);
    }).toBe(40);
    const [left, right] = await widths();
    const gutter = (await page.getByTestId('column-gutter').boundingBox())!;
    await page.mouse.move(gutter.x + gutter.width / 2, gutter.y + gutter.height / 2);
    await page.mouse.down();
    await page.mouse.move(gutter.x + gutter.width / 2 + 80, gutter.y + gutter.height / 2, { steps: 5 });
    await page.mouse.up();
    await saved(page);
    const text = await read();
    const share = Number(/width="(\d+)%" style="x"/.exec(text)![1]);
    const expected = Math.round(((left! + 80) / (left! + right!)) * 100);
    expect(Math.abs(share - expected)).toBeLessThanOrEqual(2);
    expect(text).toMatch(/^:::: \{\.columns\}\n::: \{\.column width="\d+%" style="x"\}\nLeft\n:::\n::: \{\.column width="\d+%"\}\nRight\n:::\n::::\n$/);
  });

  test('the columns reflow while the gutter is dragged; the file is written once, on release (#9j9cd5x4)', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 1280, height: 800 });
    const text = ':::: {.columns}\n::: {.column}\nLeft\n:::\n::: {.column}\nRight\n:::\n::::\n';
    await open(page, request, text);
    const leftWidth = async () => (await page.getByTestId('column').first().boundingBox())!.width;
    const before = await leftWidth();
    const gutter = (await page.getByTestId('column-gutter').boundingBox())!;
    const y = gutter.y + gutter.height / 2;
    await page.mouse.move(gutter.x + gutter.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(gutter.x + gutter.width / 2 + 100, y, { steps: 6 });
    // Still dragging: the left column is wider already, the gutter sits at its edge, and nothing is saved.
    await expect.poll(leftWidth).toBeGreaterThan(before + 80);
    const line = (await page.getByTestId('column-gutter').boundingBox())!;
    const leftBox = (await page.getByTestId('column').first().boundingBox())!;
    const rightBox = (await page.getByTestId('column').nth(1).boundingBox())!;
    const edge = (leftBox.x + leftBox.width + rightBox.x) / 2;
    expect(Math.abs(line.x + line.width / 2 - edge)).toBeLessThan(3);
    expect(await read()).toBe(text);
    await page.mouse.up();
    await saved(page);
    const widths = [...(await read()).matchAll(/width="(\d+)%"/g)].map((match) => Number(match[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThan(55);
    // Laid out by the written widths now, where the preview had it: no jump on release.
    const settled = await leftWidth();
    expect(Math.abs(settled - leftBox.width)).toBeLessThan(6);
    // One undo step puts the old layout back (the preview never entered the history).
    await page.getByTestId('editor-content').getByText('Left', { exact: true }).click();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
    await saved(page);
    await expect.poll(read).toBe(text);
  });

  test('a drag far past the edge stops at the 15% minimum, on either side', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, request, ':::: {.columns}\n::: {.column}\nLeft\n:::\n::: {.column}\nRight\n:::\n::::\n');
    const drag = async (dx: number) => {
      const gutter = (await page.getByTestId('column-gutter').boundingBox())!;
      await page.mouse.move(gutter.x + gutter.width / 2, gutter.y + gutter.height / 2);
      await page.mouse.down();
      await page.mouse.move(gutter.x + gutter.width / 2 + dx, gutter.y + gutter.height / 2, { steps: 5 });
      await page.mouse.up();
      await saved(page);
    };
    const widths = async () => [...(await read()).matchAll(/width="(\d+)%"/g)].map((match) => Number(match[1]));
    await drag(-2000);
    await expect.poll(widths).toEqual([15, 85]);
    await drag(4000);
    await expect.poll(widths).toEqual([85, 15]);
    // The narrow column still shows its text.
    await expect(page.getByTestId('column').nth(1)).toContainText('Right');
  });

  test('the resize gutter writes widths into the fences; a double-click resets them', async ({ page, request, vault }) => {
    void vault;
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, request, ':::: {.columns}\n::: {.column}\nLeft\n:::\n::: {.column}\nRight\n:::\n::::\n');
    const gutter = page.getByTestId('column-gutter');
    await expect(gutter).toHaveCount(1);
    const box = (await gutter.boundingBox())!;
    const row = (await page.getByTestId('columns').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - row.width * 0.2, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await saved(page);
    const text = await read();
    const widths = [...text.matchAll(/width="(\d+)%"/g)].map((match) => Number(match[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0]! + widths[1]!).toBe(100);
    expect(widths[0]).toBeLessThan(40);
    expect(text).toBe(`:::: {.columns}\n::: {.column width="${widths[0]}%"}\nLeft\n:::\n::: {.column width="${widths[1]}%"}\nRight\n:::\n::::\n`);
    await gutter.dblclick();
    await saved(page);
    await expect.poll(read).toBe(':::: {.columns}\n::: {.column}\nLeft\n:::\n::: {.column}\nRight\n:::\n::::\n');
  });
});

test('the outline lists headings inside columns, left column first; a click jumps into the column', async ({ page, request, vault }) => {
  void vault;
  const text = '# Top\n\n:::: {.columns}\n::: {.column}\n## Left\nA\n:::\n::: {.column}\n## Right\nB\n:::\n::::\n\n## After\n';
  await open(page, request, text);
  await page.getByTestId('outline-toggle').click();
  const items = page.getByTestId('outline-item');
  await expect(items).toHaveText(['Top', 'Left', 'Right', 'After']);
  await items.filter({ hasText: 'Right' }).click();
  const caret = await page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent ?? null);
  expect(caret).toBe('Right');
  expect(await fs.readFile(file(), 'utf8')).toBe(text);
});
