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
});
