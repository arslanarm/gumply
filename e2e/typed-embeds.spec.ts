import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #95x2fjh6: typing an Obsidian embed by hand keeps exactly what was typed.
 * A typed `![[pic.png]]` used to become an empty page embed saved as `![[]]`.
 */

/** A real 40×30 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);

const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');

async function writeVault(request: APIRequestContext) {
  // Attachments first, so the scan that finds the pages indexes them too (#8k4ssrkb).
  await fs.writeFile(path.join(E2E_VAULT, 'pic.png'), PNG);
  await fs.mkdir(path.join(E2E_VAULT, 'att'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'att', 'doc.pdf'), '%PDF-1.4\n');
  for (const [name, body] of [['Alpha.md', 'Alpha body\n'], ['Typed.md', 'Start\n']]) {
    await fs.writeFile(path.join(E2E_VAULT, name), body);
  }
  await expect
    .poll(async () => (await api.listPages(request)).map((meta) => meta.id).filter((id) => id === 'Alpha' || id === 'Typed').length, {
      timeout: 10_000,
    })
    .toBe(2);
}

test.describe('typing Obsidian embeds by hand (#95x2fjh6)', () => {
  test('typed ![[pic.png]], ![[pic.png|200]] and [[doc.pdf]] keep their bytes and show; [[Page]] and ![[Page]] still work', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request);
    try {
      await page.goto('/#/Typed');
      const editor = page.getByTestId('editor-content');
      await expect(editor).toContainText('Start');
      await editor.click();
      await page.keyboard.press('Control+End');
      // Character by character, the way a user types.
      const type = async (text: string) => {
        await page.keyboard.press('Enter');
        await page.keyboard.type(text, { delay: 40 });
      };
      await type('![[pic.png]]');
      await type('![[pic.png|200]]');
      await type('[[doc.pdf]]');
      await type('[[Alpha]]');
      await type('![[Alpha]]');

      await expect
        .poll(() => read('Typed.md'), { timeout: 10_000 })
        .toBe('Start\n\n![[pic.png]]\n\n![[pic.png|200]]\n\n[[doc.pdf]]\n\n[[Alpha]]\n\n![[Alpha]]\n');

      // Both images show, resolved across the vault (pic.png is at the root).
      const images = editor.locator('img[src^="/api/files/"]');
      await expect(images).toHaveCount(2);
      for (const index of [0, 1]) {
        await expect(images.nth(index)).toHaveAttribute('src', '/api/files/pic.png');
        await expect.poll(() => images.nth(index).evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(40);
      }
      await expect(images.nth(1)).toHaveAttribute('width', '200');
      // The file card opens the file in att/.
      await expect(editor.locator('.file-card a[href="/api/files/att/doc.pdf"]')).toBeVisible();
      // The page link and the page preview as before.
      await expect(editor.locator('wiki-link, .wiki-link').filter({ hasText: 'Alpha' }).first()).toBeVisible();
      await expect(page.getByTestId('page-embed')).toContainText('Alpha body');

      // After a reload, the same bytes and the same things.
      await page.reload();
      await expect(editor.locator('img[src^="/api/files/"]')).toHaveCount(2);
      expect(await read('Typed.md')).toBe('Start\n\n![[pic.png]]\n\n![[pic.png|200]]\n\n[[doc.pdf]]\n\n[[Alpha]]\n\n![[Alpha]]\n');
    } finally {
      await fs.rm(path.join(E2E_VAULT, 'pic.png'), { force: true });
      await fs.rm(path.join(E2E_VAULT, 'att', 'doc.pdf'), { force: true });
    }
  });

  test('a typed image inside a sentence stays in the sentence', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request);
    try {
      await page.goto('/#/Typed');
      const editor = page.getByTestId('editor-content');
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' see ![[pic.png]] here', { delay: 40 });
      await expect.poll(() => read('Typed.md'), { timeout: 10_000 }).toBe('Start see ![[pic.png]] here\n');
      await expect(editor.locator('img[src="/api/files/pic.png"]')).toHaveCount(1);
      // Inline, inside the same paragraph as the text around it (not a block that splits it).
      const image = editor.getByTestId('inline-image');
      await expect(image).toHaveCount(1);
      const sentence = editor.locator('p:has([data-testid="inline-image"])');
      await expect(sentence).toHaveCount(1);
      await expect(sentence).toContainText('Start see');
      await expect(sentence).toContainText('here');
    } finally {
      await fs.rm(path.join(E2E_VAULT, 'pic.png'), { force: true });
      await fs.rm(path.join(E2E_VAULT, 'att', 'doc.pdf'), { force: true });
    }
  });

  test('Ctrl+Z right after the rule fires gives back the typed text', async ({ page, request, vault }) => {
    void vault;
    await writeVault(request);
    try {
      await page.goto('/#/Typed');
      const editor = page.getByTestId('editor-content');
      await expect(editor).toContainText('Start');
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('![[pic.png]]', { delay: 40 });
      await expect(editor.locator('img[src="/api/files/pic.png"]')).toHaveCount(1);
      await page.keyboard.press('ControlOrMeta+z');
      await expect(editor.locator('img[src^="/api/files/"]')).toHaveCount(0);
      await expect(editor).toContainText('![[pic.png]]');
      await expect.poll(() => read('Typed.md'), { timeout: 10_000 }).toBe('Start\n\n![[pic.png]]\n');
    } finally {
      await fs.rm(path.join(E2E_VAULT, 'pic.png'), { force: true });
      await fs.rm(path.join(E2E_VAULT, 'att', 'doc.pdf'), { force: true });
    }
  });
});
