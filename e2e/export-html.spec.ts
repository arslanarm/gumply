import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * G1 (#732rxtdm): a page exports to one self-contained .html file that opens
 * offline, with its images inlined and no network request at all.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** A real 40×30 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);

const TRIP = [
  '---',
  'icon: 🧭',
  'cover: "[[att/cover.png]]"',
  'background: green',
  'status: Planning',
  '---',
  '',
  '# Itinerary',
  '',
  'We leave on **Friday** with ==tickets==, <span style="color: var(--color-red);">red text</span> and #travel.',
  '',
  '- [ ] Book train',
  '- [x] Pack bag',
  '',
  '| Day | Where |',
  '| --- | --- |',
  '| 1 | Lisbon |',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '> [!tip]- Remember',
  '> Bring an adapter.',
  '',
  '![[photo.png]]',
  '',
  'See [[Packing]] and [[Nowhere]].',
  '',
  '![[Packing#List]]',
  '',
  '![[Trips/Plans.base]]',
  '',
  '![[Map.canvas]]',
  '',
  'Energy: $E = mc^2$.',
  '',
  '```mermaid',
  'graph TD; Start-->Finish',
  '```',
  '',
].join('\n');

async function writeVault(request: APIRequestContext) {
  const files: Record<string, string | Buffer> = {
    'att/cover.png': PNG,
    'att/photo.png': PNG,
    'Trips/Packing.md': '# Intro\nSkip this\n\n# List\n- Socks\n- Charger\n',
    'Trips/Plans.base': "filters: 'file.inFolder(\"Trips\")'\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n",
    'Trips/Map.canvas': JSON.stringify({ nodes: [], edges: [] }),
    'Trips/Trip plan.md': TRIP,
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, relative)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, relative), content);
  }
  await expect
    .poll(async () => (await api.listPages(request)).map((meta) => meta.id).filter((id) => id.startsWith('Trips/')).length, { timeout: 10_000 })
    .toBe(4);
}

async function exportFromMenu(page: Page, theme: 'light' | 'dark' | 'system', links: 'text' | 'files'): Promise<string> {
  await page.getByTestId('page-menu-button-Trips/Trip plan').click();
  await page.getByTestId('export-html-Trips/Trip plan').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId(`export-theme-${theme}`).check();
  await page.getByTestId(`export-links-${links}`).check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  expect(download.suggestedFilename()).toBe('Trip plan.html');
  const target = test.info().outputPath(`Trip plan-${theme}-${links}.html`);
  await download.saveAs(target);
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  return target;
}

/** Open the exported file in a fresh context with every non-file request recorded and blocked. */
async function openOffline(browser: Browser, file: string) {
  const context = await browser.newContext({ offline: true });
  const requests: string[] = [];
  context.on('request', (request) => {
    if (!request.url().startsWith('file:')) requests.push(request.url());
  });
  await context.route(/^(?!file:)/, (route) => route.abort());
  const viewer = await context.newPage();
  await viewer.goto(pathToFileURL(file).href);
  return { context, viewer, requests };
}

test.describe('export a page as HTML (G1)', () => {
  test('from the row menu: one file that opens offline, with everything inlined and no requests', async ({ page, request, browser, vault }) => {
    void vault;
    await writeVault(request);
    await page.goto('/#/Trips/Trip plan');
    await expectPageTitle(page, 'Trip plan');

    const file = await exportFromMenu(page, 'dark', 'files');
    const html = await fs.readFile(file, 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");

    const { context, viewer, requests } = await openOffline(browser, file);
    try {
      await expect(viewer).toHaveTitle('Trip plan');
      await expect(viewer.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(viewer.locator('.export-title')).toHaveText('Trip plan');
      await expect(viewer.locator('.export-icon')).toHaveText('🧭');
      await expect(viewer.locator('.export-properties')).toContainText('Planning');
      await expect(viewer.locator('.export-body > h1')).toHaveText('Itinerary');
      await expect(viewer.locator('.export-body mark')).toHaveText('tickets');
      await expect(viewer.locator('.md-color')).toHaveText('red text');
      await expect(viewer.locator('.tag-chip')).toHaveText('#travel');
      await expect(viewer.locator('ul[data-type="taskList"] input[type="checkbox"]')).toHaveCount(2);
      await expect(viewer.locator('li[data-checked="true"]')).toContainText('Pack bag');
      await expect(viewer.locator('.export-body table').first()).toContainText('Lisbon');
      await expect(viewer.locator('pre code .hljs-keyword').first()).toHaveText('const');
      await expect(viewer.locator('.callout .callout-icon svg')).toHaveCount(1);
      await expect(viewer.locator('.callout')).toContainText('Bring an adapter.');
      // Links to sibling files; a missing page stays text.
      await expect(viewer.locator('p > a.wiki-link', { hasText: 'Packing' })).toHaveAttribute('href', 'Packing.html');
      await expect(viewer.locator('span.wiki-link.is-unresolved')).toHaveText('Nowhere');
      // The page preview, inlined: only its section.
      await expect(viewer.locator('.export-embed')).toContainText('Charger');
      await expect(viewer.locator('.export-embed')).not.toContainText('Skip this');
      // The database view as a table, the board by name.
      await expect(viewer.locator('.export-base')).toContainText('Trip plan');
      await expect(viewer.locator('.export-board')).toContainText('Map');
      // Every image is a data: URI and has loaded.
      const images = viewer.locator('img');
      await expect(images).toHaveCount(2);
      for (const index of [0, 1]) {
        await expect(images.nth(index)).toHaveAttribute('src', /^data:image\/png;base64,/);
        await expect.poll(() => images.nth(index).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(40);
      }
      // F1/F2: the formula as MathML, the diagram as an inline SVG, both with no request.
      await expect(viewer.locator('.export-body math')).toHaveCount(1);
      await expect(viewer.locator('.export-diagram svg')).toHaveCount(1);
      await expect(viewer.locator('.export-diagram')).toContainText('Finish');
      expect(requests).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('from Cmd+K, with the remembered choices; plain-text links by default', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request);
    await page.goto('/#/Trips/Trip plan');
    await expectPageTitle(page, 'Trip plan');
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('export');
    await page.getByTestId('search-export-html').click();
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    await expect(page.getByTestId('export-theme-light')).toBeChecked();
    await expect(page.getByTestId('export-links-text')).toBeChecked();
    await page.getByTestId('export-theme-system').check();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
    const html = await fs.readFile((await download.path())!, 'utf8');
    expect(html).toContain('data-theme="system"');
    expect(html).toContain('<span class="wiki-link">Packing</span>');
    expect(html).not.toContain('Packing.html');

    // The choice is remembered; Escape closes the dialog.
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('export');
    await page.getByTestId('search-export-html').click();
    await expect(page.getByTestId('export-theme-system')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  });
});
