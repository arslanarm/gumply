import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #4usgpjh8: the `![[` menu also offers files anywhere in the vault. Picking
 * one writes what Obsidian writes for that choice (its default "shortest path
 * when possible": the bare name when it resolves back to the file, else the
 * full path), and makes the same node as typing it (#95x2fjh6).
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKElEQVR4nGN46uGLFRksycGKGEY10CSU/N2eYkVf92lgRaMa/GkRSgDmzYPQlb6eFgAAAABJRU5ErkJggg==',
  'base64',
);

const read = (name: string) => fs.readFile(path.join(E2E_VAULT, name), 'utf8');

async function write(files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, name)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, name), content);
  }
}

async function openNote(page: Page, request: Parameters<typeof api.listPages>[0]) {
  await write({
    'Note.md': 'Start\n',
    'Plan.md': 'The plan page\n',
    'Plan.png': PNG,
    'att/mountain.png': PNG,
    'Projects/pic.png': PNG,
    'Notes/img/pic.png': PNG,
    'Files/report.pdf': '%PDF-1.4\n',
  });
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Note');
  await page.goto('/#/Note');
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

/** A new line under "Start", then `![[` + `query`. */
async function embedQuery(page: Page, query: string) {
  await page.getByTestId('editor-content').getByText('Start', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`![[${query}`);
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

test.describe('![[ offers vault files (#4usgpjh8)', () => {
  test('an image in a folder: offered by name, written as Obsidian writes it, shown as an image block', async ({ page, request, vault }) => {
    void vault;
    await openNote(page, request);
    await embedQuery(page, 'moun');
    const row = page.getByTestId('link-suggestion-file-att/mountain.png');
    await expect(row).toBeVisible();
    await expect(row).toContainText('mountain.png');
    await row.click();
    const image = page.getByTestId('editor-content').locator('img').first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(16);
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start\n\n![[mountain.png]]\n');
  });

  test('two files share a name: the one the bare name reaches gets it, the other its full path', async ({ page, request, vault }) => {
    void vault;
    await openNote(page, request);
    await embedQuery(page, 'pic');
    await expect(page.getByTestId('link-suggestion-file-Projects/pic.png')).toBeVisible();
    // Labelled by its full path, the link it will get.
    const deep = page.getByTestId('link-suggestion-file-Notes/img/pic.png');
    await expect(deep).toContainText('Notes/img/pic.png');
    await deep.click();
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start\n\n![[Notes/img/pic.png]]\n');
  });

  test('a PDF becomes a file card; a page and an image with the same name are both offered', async ({ page, request, vault }) => {
    void vault;
    await openNote(page, request);
    await embedQuery(page, 'report');
    await page.getByTestId('link-suggestion-file-Files/report.pdf').click();
    await expect(page.getByTestId('editor-content').getByText('report.pdf')).toBeVisible();
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start\n\n![[report.pdf]]\n');

    // `Plan.md` (a page preview) and `Plan.png` (an image) are separate rows.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('![[Plan');
    await expect(page.getByTestId('link-suggestion-Plan')).toBeVisible();
    await page.getByTestId('link-suggestion-file-Plan.png').click();
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start\n\n![[report.pdf]]\n\n![[Plan.png]]\n');
  });

  test('picked inside a line, an image stays inline next to the text', async ({ page, request, vault }) => {
    void vault;
    await openNote(page, request);
    await page.getByTestId('editor-content').getByText('Start', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' see ![[moun');
    await page.getByTestId('link-suggestion-file-att/mountain.png').click();
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start see ![[mountain.png]]\n');
  });
});
