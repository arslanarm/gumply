import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Download, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { measure } from './support/perf';

/**
 * Board export (spec/v0-6 §D, #yewapn9k): the ⋯ menu exports the board or
 * the selection as PNG (2×) or SVG, on the theme background or transparent.
 * The PNG is compared with the board on screen at 100%: shapes, colours,
 * connectors and images match closely; text is set in the embedded export
 * font (Inter) rather than the system font, so text areas get a tolerance.
 */

interface Item {
  id: string;
  type: string;
  [key: string]: unknown;
}

/** A 16×16 PNG with four coloured quadrants. */
const QUADRANTS_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKElEQVR4nGN46uGLFRksycGKGEY10CSU/N2eYkVf92lgRaMa/GkRSgDmzYPQlb6eFgAAAABJRU5ErkJggg==';

const PADDING = 32;

async function makeBoard(request: APIRequestContext, title: string, nodes: Item[], edges: Item[] = []): Promise<string> {
  const created = await request.post('/api/boards', { data: { title } });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { meta: { id: string } }).meta.id;
  const saved = await request.put(`/api/boards/${encodeURIComponent(id)}`, { data: { board: { nodes, edges } } });
  expect(saved.ok()).toBe(true);
  return id;
}

async function uploadImage(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/attachments', {
    multipart: { file: { name: 'quadrants.png', mimeType: 'image/png', buffer: Buffer.from(QUADRANTS_PNG, 'base64') } },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { path: string }).path;
}

/** Open a board at 100% with the content's top-left (minus the export padding) at the board's corner. */
async function openAligned(page: Page, id: string, minX: number, minY: number, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ([key, view, themeValue]) => {
      window.localStorage.setItem(key, view);
      window.localStorage.setItem('gumply:theme', themeValue);
    },
    [`gumply:board-view:${id}`, JSON.stringify({ x: PADDING - minX, y: PADDING - minY, zoom: 1 }), theme] as const,
  );
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`/#/${id.split('/').map(encodeURIComponent).join('/')}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
}

async function exportBoard(page: Page, format: 'png' | 'svg', options: { selection?: boolean; transparent?: boolean } = {}) {
  await page.getByTestId('board-menu-button').click();
  const selection = page.getByTestId('board-export-selection');
  if (!(await selection.isDisabled()) && (await selection.isChecked()) !== Boolean(options.selection)) await selection.click();
  const transparent = page.getByTestId('board-export-transparent');
  if ((await transparent.isChecked()) !== Boolean(options.transparent)) await transparent.click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(`board-export-${format}`).click()]);
  return download;
}

async function downloaded(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error('download failed');
  return readFileSync(path);
}

/** PNG size from its header. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/**
 * Compare two PNGs in the page (scaled to the same size): the share of
 * pixels differing by more than `threshold` in any channel, per region.
 */
async function mismatch(
  page: Page,
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Promise<number[]> {
  return page.evaluate(
    async ({ a, b, width, height, regions }) => {
      const load = async (data: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const [left, right] = await Promise.all([load(a), load(b)]);
      return regions.map((region) => {
        let differing = 0;
        let total = 0;
        for (let y = Math.max(0, region.y); y < Math.min(height, region.y + region.height); y += 1) {
          for (let x = Math.max(0, region.x); x < Math.min(width, region.x + region.width); x += 1) {
            const at = (y * width + x) * 4;
            total += 1;
            if (
              Math.abs(left[at]! - right[at]!) > 48 ||
              Math.abs(left[at + 1]! - right[at + 1]!) > 48 ||
              Math.abs(left[at + 2]! - right[at + 2]!) > 48
            ) {
              differing += 1;
            }
          }
        }
        return total === 0 ? 0 : differing / total;
      });
    },
    { a: a.toString('base64'), b: b.toString('base64'), width, height, regions },
  );
}

/** Hide the board chrome (grid dots, toolbars, menus) for a clean on-screen capture. */
async function screenCapture(page: Page, width: number, height: number): Promise<Buffer> {
  await page.addStyleTag({
    content:
      '.board-grid, .board-toolbar, .board-zoom, .board-menu, .react-flow__attribution, .react-flow__handle { visibility: hidden !important; }',
  });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(100);
  const box = (await page.getByTestId('board').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(width);
  expect(box.height).toBeGreaterThanOrEqual(height);
  return page.screenshot({ clip: { x: box.x, y: box.y, width, height } });
}

function validSvg(svg: string): void {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).not.toContain('foreignObject');
  try {
    execFileSync('xmllint', ['--noout', '-'], { input: svg, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') throw new Error(`xmllint: ${String((error as { stderr?: Buffer }).stderr ?? error)}`);
  }
}

test.describe('board export (#yewapn9k)', () => {
  test('PNG matches the board on screen: shapes, colours, connectors and images', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    const image = await uploadImage(request);
    const nodes: Item[] = [
      { id: 'frame000000000001', type: 'group', x: 0, y: 0, width: 620, height: 420, color: '5', label: '' },
      { id: 'shape00000000001', type: 'text', text: '', gumply: { kind: 'shape', shape: 'ellipse' }, x: 40, y: 40, width: 200, height: 140, color: '4' },
      { id: 'shape00000000002', type: 'text', text: '', gumply: { kind: 'shape', shape: 'diamond' }, x: 360, y: 40, width: 200, height: 140, color: '1' },
      { id: 'sticky0000000001', type: 'text', text: '', gumply: { kind: 'sticky' }, x: 40, y: 230, width: 160, height: 160, color: '3' },
      { id: 'image00000000001', type: 'file', file: image, x: 380, y: 230, width: 160, height: 160 },
    ];
    const edges: Item[] = [{ id: 'edge000000000001', fromNode: 'shape00000000001', fromSide: 'right', toNode: 'shape00000000002', toSide: 'left', color: '6' }];
    const id = await makeBoard(request, 'Pixels', nodes, edges);
    await openAligned(page, id, 0, 0);
    await expect(page.getByTestId('board-image')).toBeVisible();

    const png = await downloaded(await exportBoard(page, 'png'));
    const size = pngSize(png);
    const width = 620 + PADDING * 2;
    const height = 420 + PADDING * 2;
    // 2×, as in the spec.
    expect(size).toEqual({ width: width * 2, height: height * 2 });

    const screen = await screenCapture(page, width, height);
    const whole = { x: 0, y: 0, width, height };
    const region = (node: Item) => ({ x: (node.x as number) + PADDING, y: (node.y as number) + PADDING, width: node.width as number, height: node.height as number });
    const [all, ellipse, diamond, sticky, picture] = await mismatch(page, png, screen, width, height, [
      whole,
      region(nodes[1]!),
      region(nodes[2]!),
      region(nodes[3]!),
      region(nodes[4]!),
    ]);
    // Only antialiasing differs: under 1% of pixels anywhere, per object too.
    expect(all).toBeLessThan(0.01);
    for (const value of [ellipse, diamond, sticky, picture]) expect(value).toBeLessThan(0.02);
  });

  test('text is drawn in the embedded font, within a tolerance of the screen; the SVG is valid', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Roadmap', content: 'Ship the export feature this week.' }]);
    const nodes: Item[] = [
      { id: 'sticky0000000001', type: 'text', text: 'Plan the launch', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 220, height: 160, color: '3' },
      { id: 'shape00000000001', type: 'text', text: 'Décision', gumply: { kind: 'shape', shape: 'rounded' }, x: 300, y: 30, width: 200, height: 100, color: '5' },
      { id: 'text000000000001', type: 'text', text: 'A plain *note* with **bold**', x: 0, y: 220, width: 300, height: 60 },
      { id: 'card000000000001', type: 'file', file: 'Roadmap.md', x: 300, y: 200, width: 280, height: 160 },
    ];
    const edges: Item[] = [{ id: 'edge000000000001', fromNode: 'sticky0000000001', fromSide: 'right', toNode: 'shape00000000001', toSide: 'left', label: 'then' }];
    const id = await makeBoard(request, 'Words', nodes, edges);
    await openAligned(page, id, 0, 0);
    await expect(page.getByTestId('board-page-card-preview')).toContainText('Ship the export');

    const svg = (await downloaded(await exportBoard(page, 'svg'))).toString('utf8');
    validSvg(svg);
    // The font is embedded (latin, plus latin-ext for "é"? no: é is latin-1; italic for *note*).
    expect(svg).toMatch(/@font-face\{font-family:"Inter";font-style:normal;[^}]*src:url\(data:font\/woff2;base64,/);
    expect(svg).toContain('font-style:italic');
    expect(svg).not.toMatch(/U\+0100-02BA[^}]*base64/);
    for (const text of ['Plan the', 'launch', 'Décision', 'bold', 'then', 'Roadmap', 'Ship the export feature this week.']) {
      expect(svg).toContain(text);
    }
    // The browser parses it as SVG, with no errors.
    const parsed = await page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      return { error: doc.querySelector('parsererror')?.textContent ?? null, root: doc.documentElement.nodeName, texts: doc.querySelectorAll('text').length };
    }, svg);
    expect(parsed).toMatchObject({ error: null, root: 'svg' });
    expect(parsed.texts).toBeGreaterThan(5);

    const png = await downloaded(await exportBoard(page, 'png'));
    const width = 580 + PADDING * 2;
    const height = 360 + PADDING * 2;
    const screen = await screenCapture(page, width, height);
    const [all] = await mismatch(page, png, screen, width, height, [{ x: 0, y: 0, width, height }]);
    // Different font, same layout: only glyph pixels differ.
    expect(all).toBeLessThan(0.06);
  });

  test('selection only, transparent background, and the theme background in dark mode', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    const nodes: Item[] = [
      { id: 'sticky0000000001', type: 'text', text: 'Keep me', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 160, height: 160, color: '4' },
      { id: 'sticky0000000002', type: 'text', text: 'Leave me out', gumply: { kind: 'sticky' }, x: 400, y: 0, width: 160, height: 160, color: '1' },
    ];
    const id = await makeBoard(request, 'Two notes', nodes);
    await openAligned(page, id, 0, 0, 'dark');
    await page.getByTestId('board-sticky').filter({ hasText: 'Keep me' }).click();

    // With something selected, the menu offers (and pre-checks) "Selection only".
    await page.getByTestId('board-menu-button').click();
    await expect(page.getByTestId('board-export-selection')).toBeChecked();
    await page.keyboard.press('Escape');

    const selected = await exportBoard(page, 'svg', { selection: true });
    expect(selected.suggestedFilename()).toBe('Two notes (selection).svg');
    const svg = (await downloaded(selected)).toString('utf8');
    expect(svg).toContain('Keep me');
    expect(svg).not.toContain('Leave me');
    expect(svg).toContain('width="224" height="224"');

    // Transparent: the corner is see-through; theme: the dark board surface.
    const clear = await downloaded(await exportBoard(page, 'png', { selection: true, transparent: true }));
    const opaque = await downloaded(await exportBoard(page, 'png', { selection: true, transparent: false }));
    const corners = await page.evaluate(
      async ([a, b]) => {
        const pixel = async (data: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(2, 2, 1, 1).data);
        };
        return [await pixel(a), await pixel(b)];
      },
      [clear.toString('base64'), opaque.toString('base64')] as const,
    );
    expect(corners[0]![3]).toBe(0);
    expect(corners[1]![3]).toBe(255);
    // Dark theme surface (#161616).
    expect(corners[1]!.slice(0, 3)).toEqual([22, 22, 22]);

    // Nothing selected: the whole board, and "Selection only" is unavailable.
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 700);
    const whole = await exportBoard(page, 'svg');
    expect(whole.suggestedFilename()).toBe('Two notes.svg');
    expect((await downloaded(whole)).toString('utf8')).toContain('Leave me');
    await page.getByTestId('board-menu-button').click();
    await expect(page.getByTestId('board-export-selection')).toBeDisabled();
  });

  test('SVG colours work outside browsers: default frames are not black in librsvg', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    // Default (uncoloured) frames use color-mix(), which computes to color(srgb …).
    const nodes: Item[] = [
      { id: 'frame000000000001', type: 'group', x: 0, y: 0, width: 300, height: 300, label: 'Monday' },
      { id: 'frame000000000002', type: 'group', x: 340, y: 0, width: 300, height: 300, label: 'Tuesday' },
      { id: 'sticky0000000001', type: 'text', text: 'Task', gumply: { kind: 'sticky' }, x: 20, y: 20, width: 120, height: 80 },
    ];
    const id = await makeBoard(request, 'Plain frames', nodes);
    for (const theme of ['light', 'dark'] as const) {
      // Same URL twice doesn't reload: leave the page so the theme applies.
      await page.goto('about:blank');
      await openAligned(page, id, 0, 0, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const transparent of [false, true]) {
        const svg = (await downloaded(await exportBoard(page, 'svg', { transparent }))).toString('utf8');
        validSvg(svg);
        // Only SVG 1.1 colour syntax: no CSS Color 4 functions, no rgba().
        const body = svg.replace(/<style>[\s\S]*?<\/style>/, '');
        expect(body).not.toMatch(/color\(|color-mix\(|oklch\(|oklab\(|\blab\(|\blch\(|rgba\(/);
        expect(body).toMatch(/fill="rgb\(\d+, \d+, \d+\)" fill-opacity="0\.\d+"/);

        let rendered: Buffer | null = null;
        try {
          rendered = execFileSync('rsvg-convert', ['-z', '1'], { input: svg, maxBuffer: 64 * 1024 * 1024 });
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
        if (!rendered) continue;
        // Inside the Tuesday frame (empty): what librsvg drew vs. the board surface.
        const pixel = await page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(32 + 490, 32 + 200, 1, 1).data);
        }, rendered.toString('base64'));
        if (transparent) {
          // A ~4% tint over nothing: almost fully see-through, never a black slab.
          expect(pixel[3]).toBeLessThan(40);
        } else {
          const surface = theme === 'light' ? [251, 251, 250] : [22, 22, 22];
          for (let index = 0; index < 3; index += 1) expect(Math.abs(pixel[index]! - surface[index]!)).toBeLessThan(16);
        }
      }
    }
  });

  // The spec's 3 s is measured on a production build: scripts/export-perf.mjs
  // (--check). This dev-server run guards against regressions (before batched
  // text fitting it took ~7 s) without flaking when the machine is busy.
  test('a 1000-object board exports completely and quickly', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`/board-lab.html?seed=1000&mix=1&id=export-${Date.now()}`);
    await page.waitForSelector('.react-flow__node');
    for (const format of ['svg', 'png'] as const) {
      const { bytes } = await measure(
        testInfo,
        `1000-object ${format} export`,
        async () => {
          const started = Date.now();
          const bytes = await downloaded(await exportBoard(page, format));
          const elapsed = Date.now() - started;
          console.log(`1000 objects → ${format}: ${elapsed} ms, ${(bytes.length / 1024).toFixed(0)} KB`);
          return { bytes, elapsed };
        },
        (r) => [[r.elapsed, 6000, `1000-object ${format} export ms`]],
        { attempts: 2 },
      );
      if (format === 'svg') {
        validSvg(bytes.toString('utf8'));
        // Every sticky made it in, not just the ones on screen.
        expect((bytes.toString('utf8').match(/Sticky \d+/g) ?? []).length).toBeGreaterThan(300);
      }
    }
  });
});
