import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * G2 (#dhf34uv5), browser side: "Export as PDF…" prints G1's document from a
 * hidden iframe (the browser's dialog saves the PDF). The print stylesheet:
 * the paper size, light colours, wrapped code, repeated table headers,
 * headings kept with what follows, images within the page.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** A real 40×30 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);

const rows = Array.from({ length: 60 }, (_, index) => `| ${index + 1} | Item ${index + 1} |`).join('\n');
const REPORT = [
  '## Summary',
  '',
  'A line of text.',
  '',
  '![[chart.png]]',
  '',
  '```js',
  `const veryLongLine = "${'x'.repeat(300)}";`,
  '```',
  '',
  '| # | Name |',
  '| --- | --- |',
  rows,
  '',
].join('\n');

async function writeVault(request: APIRequestContext) {
  await fs.writeFile(path.join(E2E_VAULT, 'chart.png'), PNG);
  await fs.writeFile(path.join(E2E_VAULT, 'Report.md'), REPORT);
  await expect.poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Report'), { timeout: 10_000 }).toBe(true);
}

test('Export as PDF prints the page from a hidden frame; the print stylesheet lays it out for paper', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request);
  await page.addInitScript(() => window.localStorage.setItem('gumply:theme', 'dark'));
  await page.goto('/#/Report');
  await expectPageTitle(page, 'Report');

  // The print frame's own print() is recorded instead of opening the browser's dialog.
  await page.evaluate(() => {
    (window as unknown as { __printed: string[] }).__printed = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLIFrameElement && node.dataset.testid === 'print-frame') {
            node.addEventListener('load', () => {
              const view = node.contentWindow as (Window & { print: () => void }) | null;
              if (view) view.print = () => (window as unknown as { __printed: string[] }).__printed.push(node.srcdoc);
            }, { capture: true });
          }
        }
      }
    }).observe(document.body, { childList: true });
  });

  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('pdf');
  await page.getByTestId('search-export-pdf').click();
  await expect(page.getByTestId('export-dialog')).toContainText('Export as PDF');
  await page.getByTestId('export-size-A4').check();
  await page.getByTestId('export-margins-normal').check();
  await page.getByTestId('export-confirm').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.length)).toBe(1);
  const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed[0]!);

  // The document printed: light (even with the app in dark), with the paper rule, no script.
  expect(printed).toContain('data-theme="light"');
  expect(printed).toContain('@page { size: A4; margin: 18mm; }');
  expect(printed).not.toMatch(/<script/i);

  // Its layout in print.
  const viewer = await page.context().newPage();
  await viewer.setContent(printed);
  await viewer.emulateMedia({ media: 'print', colorScheme: 'dark' });
  const style = (selector: string, property: string) =>
    viewer.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
  expect(await style('body', 'background-color')).toMatch(/rgba\(0, 0, 0, 0\)|rgb\(255, 255, 255\)/);
  expect(await style('.export-body h2', 'break-after')).toBe('avoid');
  expect(await style('.export-body pre', 'white-space')).toBe('pre-wrap');
  expect(await style('.export-body thead', 'display')).toBe('table-header-group');
  expect(await style('.export-body tr', 'break-inside')).toBe('avoid');
  expect(await style('.export-footer', 'display')).toBe('none');
  // Wrapped code and the image stay within the page width.
  const pageWidth = await viewer.evaluate(() => document.documentElement.clientWidth);
  expect((await viewer.locator('.export-body pre').boundingBox())!.width).toBeLessThanOrEqual(pageWidth);
  expect((await viewer.locator('.export-body img').boundingBox())!.width).toBeLessThanOrEqual(pageWidth);
  await viewer.close();
});
