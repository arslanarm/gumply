import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 F2 (#d57wfbzd): Mermaid diagrams over ```mermaid code blocks. Render,
 * click to edit, Esc back, exact bytes, theme switch, /mermaid, a preview, an
 * error inline, a hostile diagram staying inert, and no request outside the app.
 */

const file = (name: string) => path.join(E2E_VAULT, name);
const body = async (name: string) => (await readFile(file(name), 'utf8')).replace(/^---\n[\s\S]*?\n---\n\n?/, '');

const FLOW = '```mermaid\nflowchart LR\n  A[Start] --> B{Ready?}\n  B -- yes --> C[Ship]\n```';

test.afterEach(async () => {
  await rm(file('F2 Board.canvas'), { force: true });
});

async function open(page: Page, title: string) {
  await page.goto(`/#/${encodeURIComponent(title)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

/** Requests that leave the app (the dev server is localhost). */
function watchNetwork(page: Page): string[] {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) outside.push(request.url());
  });
  return outside;
}

test('a mermaid block renders, edits as source, Esc goes back; bytes exact; follows the theme', async ({ page, vault }) => {
  const outside = watchNetwork(page);
  await vault.seed([{ title: 'Diagrams', content: `Intro.\n\n${FLOW}\n\nAfter.` }]);
  const original = await body('Diagrams.md');
  await open(page, 'Diagrams');
  const block = page.getByTestId('code-block').filter({ has: page.getByTestId('mermaid-diagram') });
  const diagram = block.getByTestId('mermaid-diagram');
  await expect(diagram.locator('svg')).toBeVisible();
  await expect(diagram).toContainText('Ship');
  await expect(block.locator('pre')).toBeHidden();

  // Click: the source shows; Esc: back to the diagram, nothing written.
  await diagram.click();
  await expect(block.locator('pre')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(block.locator('pre')).toBeHidden();
  await page.waitForTimeout(800);
  expect(await body('Diagrams.md')).toBe(original);

  // Edit: a comment line at the start; only those bytes change.
  await diagram.click();
  await page.keyboard.type('%% reviewed\n');
  await page.keyboard.press('Escape');
  await expect(diagram).toContainText('Ship');
  await expect.poll(() => body('Diagrams.md'), { timeout: 5_000 }).toBe(original.replace('```mermaid\n', '```mermaid\n%% reviewed\n'));

  // Theme switch: the diagram is drawn again in the dark theme.
  await expect(diagram).toHaveAttribute('data-diagram-theme', 'light');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(diagram).toHaveAttribute('data-diagram-theme', 'dark');
  await expect(diagram.locator('svg')).toBeVisible();
  expect(outside).toEqual([]);
});

test('a hostile diagram stays inert: no script, no handlers, no javascript: links, no network', async ({ page, vault }) => {
  const outside = watchNetwork(page);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const hostile = [
    '```mermaid',
    '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%',
    'flowchart LR',
    '  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]',
    '  B --> C["<a href=\'javascript:alert(3)\'>link</a>"]',
    '  C --> D[Remote]',
    '  click A call alert(4)',
    '  click B href "javascript:alert(5)"',
    '  click D "https://example.com/track.png"',
    '```',
  ].join('\n');
  await vault.seed([{ title: 'Hostile', content: hostile }]);
  await open(page, 'Hostile');
  const diagram = page.getByTestId('mermaid-diagram');
  // It must really be drawn (not rejected as a parse error), or the checks below prove nothing.
  await expect(diagram.locator('svg')).toBeVisible();
  await expect(diagram).toContainText('Remote');
  const report = await diagram.evaluate((element) => ({
    scripts: element.querySelectorAll('script').length,
    foreign: element.querySelectorAll('foreignObject').length,
    images: element.querySelectorAll('img, image').length,
    handlers: [...element.querySelectorAll('*')].flatMap((node) => [...node.attributes].filter((a) => a.name.toLowerCase().startsWith('on')).map((a) => a.name)),
    links: [...element.querySelectorAll('[href], [xlink\\:href]')].map((node) => node.getAttribute('href') ?? node.getAttribute('xlink:href')),
  }));
  expect(report.scripts).toBe(0);
  expect(report.foreign).toBe(0);
  expect(report.images).toBe(0);
  expect(report.handlers).toEqual([]);
  for (const href of report.links) expect(href).toMatch(/^#/);
  // Clicking the nodes runs nothing (and opens the source instead).
  await diagram.click();
  await page.waitForTimeout(500);
  expect(dialogs).toEqual([]);
  expect(outside).toEqual([]);
  // And the file is untouched.
  expect(await body('Hostile.md')).toBe(`${hostile}\n`);
});

test('/mermaid inserts a starter diagram; errors show inline; previews draw diagrams', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Broken', content: '```mermaid\nflowchart LR\n  A --> \n  ((( nope\n```' },
    { title: 'Diagrams', content: FLOW },
    { title: 'Host', content: '![[Diagrams]]' },
    { title: 'Slash', content: 'Start.' },
  ]);
  await open(page, 'Broken');
  await expect(page.getByTestId('mermaid-diagram').locator('.diagram-error')).toBeVisible();

  await open(page, 'Host');
  await expect(page.locator('.page-embed-body .mermaid-block svg')).toBeVisible();

  // A board sticky draws its diagram too.
  await writeFile(
    file('F2 Board.canvas'),
    JSON.stringify({ nodes: [{ id: 's', type: 'text', text: '```mermaid\nflowchart LR\n  X --> Y\n```', x: 0, y: 0, width: 320, height: 200, gumply: { kind: 'sticky' } }], edges: [] }),
  );
  await expect.poll(async () => (await vault.pages()).some((meta) => meta.id === 'F2 Board.canvas'), { timeout: 5_000 }).toBe(true);
  await page.goto(`/#/${encodeURIComponent('F2 Board.canvas')}`);
  await expect(page.getByTestId('board-rich-text').locator('.mermaid-block svg')).toBeVisible();

  await open(page, 'Slash');
  const editor = page.getByTestId('editor-content');
  await editor.getByText('Start.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/mermaid');
  await page.getByTestId('slash-menu-item-mermaid').click();
  await page.keyboard.press('Escape');
  await expect(editor.getByTestId('mermaid-diagram').locator('svg')).toBeVisible();
  await expect(editor.getByTestId('mermaid-diagram')).toContainText('Worth it?');
  await expect.poll(() => body('Slash.md'), { timeout: 5_000 }).toContain('```mermaid\nflowchart LR\n  A[Idea] --> B{Worth it?}');
});
