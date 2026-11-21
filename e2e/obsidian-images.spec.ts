import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #8k4ssrkb: Obsidian's `![[photo.png]]` resolves across the vault as in
 * Obsidian 1.14.4 (root, any folder, same names by the linking note's folder),
 * in pages, page previews, board text and database covers. Nothing is written.
 */

/** A real 40×30 PNG (the server serves .png as image/png with nosniff). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);
const svg = (_fill: string) => PNG;

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

/** Files (images first, so the scan that finds the pages also indexes them). */
async function writeVault(request: APIRequestContext, files: Record<string, string | Buffer>) {
  const entries = Object.entries(files).sort(([a], [b]) => Number(/\.md$|\.canvas$|\.base$/.test(a)) - Number(/\.md$|\.canvas$|\.base$/.test(b)));
  for (const [relative, content] of entries) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  const ids = Object.keys(files)
    .filter((file) => /\.(md|canvas|base)$/.test(file))
    .map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ids.every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

async function removeImages(names: string[]) {
  for (const name of names) await fs.rm(path.join(E2E_VAULT, name), { force: true });
}

async function expectLoaded(image: Locator, vaultPath: string) {
  await expect(image).toHaveAttribute('src', `/api/files/${vaultPath.split('/').map(encodeURIComponent).join('/')}`);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
}

const openPage = async (page: Page, id: string) => {
  await page.goto(`/#/${id.split('/').map(encodeURIComponent).join('/')}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
};

test.describe('Obsidian images anywhere in the vault (#8k4ssrkb)', () => {
  test('a root image and a folder image show in a page; the file is never rewritten', async ({ page, request, vault }) => {
    void vault;
    const body = 'Root ![[photo.png]] and folder ![[pic.png|100]]\n';
    await writeVault(request, { 'photo.png': svg('#e76f51'), 'att/pic.png': svg('#2a9d8f'), 'Home.md': body });
    try {
      await openPage(page, 'Home');
      const images = page.getByTestId('editor-content').locator('img[src^="/api/files/"]');
      await expect(images).toHaveCount(2);
      await expectLoaded(images.nth(0), 'photo.png');
      await expectLoaded(images.nth(1), 'att/pic.png');
      await expect(images.nth(1)).toHaveAttribute('width', '100');
      await page.waitForTimeout(800);
      expect(await read('Home.md')).toBe(body);
    } finally {
      await removeImages(['photo.png', 'att/pic.png']);
    }
  });

  test('same-named images: each note resolves from its own folder, a preview from the previewed page, a pasted link from where it lands', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request, {
      'Work/cover.png': svg('#457b9d'),
      'Home/cover.png': svg('#8ab17d'),
      // Only pasted later, so not in the page's fileLinks at load.
      'Work/other.png': svg('#e76f51'),
      'Home/other.png': svg('#e9c46a'),
      'Work/Plan.md': '![[cover.png]]\n\n![[Home/Note]]\n',
      'Home/Note.md': '![[cover.png]]\n',
    });
    try {
      await openPage(page, 'Work/Plan');
      const editor = page.getByTestId('editor-content');
      await expectLoaded(editor.locator('img[src^="/api/files/"]').first(), 'Work/cover.png');
      // The preview of Home/Note resolves its embed from Home/, not from the open page.
      await expectLoaded(page.getByTestId('page-embed').locator('img'), 'Home/cover.png');

      // A link added after load (pasted, as when copied from a page in another
      // folder): resolved once, from the page it lands in.
      await openPage(page, 'Home/Note');
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await editor.evaluate((element) => {
        const data = new DataTransfer();
        data.setData('text/plain', '![[other.png]]');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      const images = editor.locator('img[src^="/api/files/"]');
      await expect(images).toHaveCount(2);
      await expectLoaded(images.nth(1), 'Home/other.png');
    } finally {
      await removeImages(['Work/cover.png', 'Home/cover.png', 'Work/other.png', 'Home/other.png']);
    }
  });

  test('board text and database covers resolve the same way', async ({ page, request, vault }) => {
    void vault;
    const board = { nodes: [{ id: 'a', type: 'text', text: 'Map ![[map.png]]', x: 0, y: 0, width: 240, height: 160 }], edges: [] };
    await writeVault(request, {
      'Trips/map.png': svg('#e9c46a'),
      'att/cover.png': svg('#2a9d8f'),
      'Trips/Plan.canvas': JSON.stringify(board),
      'Work/A.md': '---\ncover: "[[cover.png]]"\n---\nA\n',
      'Work/All.base': "filters: 'file.inFolder(\"Work\")'\nviews:\n  - type: cards\n    name: Cards\n    image: note.cover\n",
    });
    try {
      await page.goto('/#/Trips/Plan.canvas');
      await expect(page.getByTestId('board')).toBeVisible();
      await expectLoaded(page.getByTestId('board').locator('img[data-obsidian]'), 'Trips/map.png');

      await page.goto('/#/Work/All.base');
      await expectLoaded(page.getByTestId('base-card-Work/A').locator('img'), 'att/cover.png');
    } finally {
      await removeImages(['Trips/map.png', 'att/cover.png']);
    }
  });
});
