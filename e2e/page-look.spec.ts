import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.7 F (#385sexd6): a page cover and a page background colour, stored as
 * frontmatter (`cover`, `cover-position`, `background`). Every change writes
 * only its own lines (D37); removing them gives the original bytes back.
 */

// A 16×16 PNG with four coloured quadrants.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKElEQVR4nGN46uGLFRksycGKGEY10CSU/N2eYkVf92lgRaMa/GkRSgDmzYPQlb6eFgAAAABJRU5ErkJggg==',
  'base64',
);

const filePath = (name: string) => path.join(E2E_VAULT, name);
const read = (name: string) => fs.readFile(filePath(name), 'utf8');

async function write(files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(filePath(name)), { recursive: true });
    await fs.writeFile(filePath(name), content);
  }
}

async function open(page: Page, request: Parameters<typeof api.listPages>[0], id: string) {
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain(id);
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function addCover(page: Page) {
  await page.getByTestId('page-title').hover();
  await page.getByTestId('add-cover-button').click();
  await expect(page.getByTestId('cover-picker')).toBeVisible();
}

test.describe('page cover and background (#385sexd6)', () => {
  test('a palette cover, then an uploaded image, repositioned and removed: only the cover lines ever change', async ({ page, request, vault }) => {
    void vault;
    // A plain note's first frontmatter block is followed by a blank line, as
    // with any first property (v1.12); removing it gives the bytes back.
    const original = 'Body text.\n\nSecond paragraph.\n';
    await write({ 'Plain.md': original });
    await open(page, request, 'Plain');

    await addCover(page);
    await page.getByTestId('cover-color-blue').click();
    await expect(page.getByTestId('page-cover-fill')).toBeVisible();
    await expect.poll(() => read('Plain.md')).toBe(`---\ncover: color:blue\n---\n\n${original}`);
    // Not listed as a property.
    await expect(page.getByTestId('properties-block')).not.toContainText('cover');

    await page.getByTestId('page-cover').hover();
    await page.getByTestId('cover-change').click();
    // Remove lives in the cover bar only, not in the picker too.
    await expect(page.getByTestId('cover-picker').getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await page.getByTestId('cover-tab-upload').click();
    await page.getByTestId('cover-upload-input').setInputFiles({ name: 'cover photo.png', mimeType: 'image/png', buffer: PNG });
    const image = page.getByTestId('page-cover-image');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(16);
    await expect.poll(() => read('Plain.md')).toBe(`---\ncover: "[[attachments/cover-photo.png]]"\n---\n\n${original}`);

    // Reposition: drag the image up, so its lower part shows.
    await page.getByTestId('page-cover').hover();
    await page.getByTestId('cover-reposition').click();
    const box = (await image.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId('cover-reposition-save').click();
    await expect.poll(() => read('Plain.md')).toMatch(/^---\ncover: "\[\[attachments\/cover-photo\.png\]\]"\ncover-position: (7\d|80)\n---\n/);
    const position = Number(/cover-position: (\d+)/.exec(await read('Plain.md'))![1]);
    await expect(image).toHaveCSS('object-position', `50% ${position}%`);

    await page.reload();
    await expect(page.getByTestId('page-cover-image')).toHaveCSS('object-position', `50% ${position}%`);

    await page.getByTestId('page-cover').hover();
    await page.getByTestId('cover-remove').click();
    await expect(page.getByTestId('page-cover')).toHaveCount(0);
    await expect.poll(() => read('Plain.md')).toBe(original);
  });

  test('a vault image and a gradient on a note with its own properties keep every other line', async ({ page, request, vault }) => {
    void vault;
    const original = '---\nstatus: draft # keep\naliases: [Plan]\n---\n\n# Plan\n\nText\n';
    await write({ 'Plan.md': original, 'attachments/wide.png': PNG });
    await open(page, request, 'Plan');

    await addCover(page);
    await page.getByTestId('cover-tab-vault').click();
    await page.getByTestId('cover-vault-wide.png').click();
    await expect(page.getByTestId('page-cover-image')).toBeVisible();
    await expect.poll(() => read('Plan.md')).toBe(original.replace('aliases: [Plan]\n', 'aliases: [Plan]\ncover: "[[attachments/wide.png]]"\n'));

    await page.getByTestId('page-cover').hover();
    await page.getByTestId('cover-change').click();
    await page.getByTestId('cover-gradient-dusk').click();
    await expect(page.getByTestId('page-cover-fill')).toHaveClass(/cover-gradient-dusk/);
    await expect.poll(() => read('Plan.md')).toBe(original.replace('aliases: [Plan]\n', 'aliases: [Plan]\ncover: gradient:dusk\n'));
  });

  test('a background colour tints the page, survives a reload, and Default removes it', async ({ page, request, vault }) => {
    void vault;
    const original = 'Plain body.\n';
    await write({ 'Tinted.md': original });
    await open(page, request, 'Tinted');

    await page.getByTestId('page-title').hover();
    await page.getByTestId('page-background-button').click();
    await page.getByTestId('page-background-green').click();
    await expect.poll(() => read('Tinted.md')).toBe(`---\nbackground: green\n---\n\n${original}`);
    const content = page.locator('main.content');
    await expect(content).toHaveClass(/has-page-tint/);
    const tinted = await content.evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(tinted).toContain('gradient');

    await page.reload();
    await expect(page.locator('main.content')).toHaveClass(/has-page-tint/);
    // Other pages aren't tinted.
    await write({ 'Other.md': 'x\n' });
    await open(page, request, 'Other');
    await expect(page.locator('main.content')).not.toHaveClass(/has-page-tint/);

    await open(page, request, 'Tinted');
    await page.getByTestId('page-title').hover();
    await page.getByTestId('page-background-button').click();
    await page.getByTestId('page-background-default').click();
    await expect.poll(() => read('Tinted.md')).toBe(original);
    await expect(page.locator('main.content')).not.toHaveClass(/has-page-tint/);
  });

  test('a Banners plugin cover shows, opening writes nothing, and Hide in Gumply never deletes its keys', async ({ page, request, vault }) => {
    void vault;
    // The plugin's legacy `![[…]]` form, and its icon shown when the page has none.
    const original = '---\nbanner: "![[att/banner.png]]"\nbanner_y: 0.3\nbanner_icon: 🏔️\n---\n\nText\n';
    await write({ 'Banner note.md': original, 'att/banner.png': PNG });
    await open(page, request, 'Banner note');

    const image = page.getByTestId('page-cover-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveCSS('object-position', '50% 30%');
    await expect(page.getByTestId('cover-from-banners')).toBeVisible();
    await expect(page.getByTestId('page-banner-icon')).toHaveText('🏔️');
    await expect(page.getByTestId('properties-block')).toContainText('banner');
    // Nothing is written just by looking.
    await page.waitForTimeout(1500);
    expect(await read('Banner note.md')).toBe(original);

    await page.getByTestId('page-cover').hover();
    await page.getByTestId('cover-remove').click();
    await expect(page.getByTestId('page-cover')).toHaveCount(0);
    await expect.poll(() => read('Banner note.md')).toBe(original.replace('banner_icon: 🏔️\n', 'banner_icon: 🏔️\ncover: none\n'));
  });

  test('a cover from a web address is saved into the vault first', async ({ page, request, vault }) => {
    void vault;
    const original = '---\ncover: https://example.invalid/remote.png\n---\nText\n';
    await write({ 'Remote.md': original });
    await open(page, request, 'Remote');
    // The remote image can't load here; the cover says so and offers the vault copy.
    await expect(page.getByTestId('page-cover-missing')).toBeVisible();
    expect(await read('Remote.md')).toBe(original);
  });
});
