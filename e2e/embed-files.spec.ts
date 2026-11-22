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

test.describe('![[ with file names a wikilink can\'t hold (#btgun63k)', () => {
  for (const [name, testid, bytes] of [
    ['my file [1].png', 'Files/my file [1].png', 'Start\n\n![my file \\[1\\]](Files/my%20file%20[1].png)\n'],
    // #eg65ktng: `|` escaped in the alt and encoded in the path (safe in a table cell too).
    ['pipe|x.png', 'Files/pipe|x.png', 'Start\n\n![pipe\\|x](Files/pipe%7Cx.png)\n'],
    ['a#b.png', 'Files/a#b.png', 'Start\n\n![a#b](Files/a%23b.png)\n'],
  ] as const) {
    test(`${name}: a Markdown image with a D23 link, which renders`, async ({ page, request, vault }) => {
      void vault;
      await write({ 'Note.md': 'Start\n', [`Files/${name}`]: PNG });
      await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Note');
      await page.goto('/#/Note');
      await expect(page.getByTestId('editor-content')).toBeVisible();
      // #eg65ktng: `a#b` too: `#` asks for headings only when the part before it names a page.
      await embedQuery(page, name.slice(0, 4));
      await page.getByTestId(`link-suggestion-file-${testid}`).click();
      const image = page.getByTestId('editor-content').locator('img').first();
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(16);
      await saved(page);
      // A Markdown image with the D23 note-relative link (the `[[` rows' writer).
      await expect.poll(() => read('Note.md')).toBe(bytes);
    });
  }

  test('a PDF named `notes #2.pdf` becomes a file card with a Markdown link', async ({ page, request, vault }) => {
    void vault;
    await write({ 'Note.md': 'Start\n', 'Files/notes #2.pdf': '%PDF-1.4\n' });
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Note');
    await page.goto('/#/Note');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await embedQuery(page, 'note');
    await page.getByTestId('link-suggestion-file-Files/notes #2.pdf').click();
    await expect(page.getByTestId('editor-content').getByText('notes #2.pdf')).toBeVisible();
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start\n\n[notes #2.pdf](Files/notes%20%232.pdf)\n');

    // #he3ed9uz: the inserted link survives a reload and an edit elsewhere, and a click opens the file.
    await page.reload();
    const link = page.getByTestId('editor-content').locator('a', { hasText: 'notes #2.pdf' });
    await expect(link).toHaveAttribute('href', 'Files/notes%20%232.pdf');
    await page.getByTestId('editor-content').getByText('Start', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start X\n\n[notes #2.pdf](Files/notes%20%232.pdf)\n');
    await page.evaluate(() => {
      const opened: string[] = [];
      (window as unknown as { __opened: string[] }).__opened = opened;
      window.open = ((url?: string | URL) => {
        opened.push(String(url));
        return null;
      }) as typeof window.open;
    });
    await link.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
      .toEqual(['/api/files/Files/notes%20%232.pdf']);
  });

  test('between two paragraphs the insert leaves no empty line (#eg65ktng)', async ({ page, request, vault }) => {
    void vault;
    await write({ 'Note.md': 'Start\n\nEnd\n', 'Files/a#b.png': PNG });
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Note');
    await page.goto('/#/Note');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await embedQuery(page, 'a#b');
    await page.getByTestId('link-suggestion-file-Files/a#b.png').click();
    await expect(page.getByTestId('editor-content').locator('img').first()).toBeVisible();
    await saved(page);
    await expect.poll(() => read('Note.md')).toBe('Start\n\n![a#b](Files/a%23b.png)\n\nEnd\n');
  });

  test('in a table cell, a file with `|` in its name keeps the table intact (#eg65ktng)', async ({ page, request, vault }) => {
    void vault;
    const table = '| Name | File |\n| --- | --- |\n| one | cell |\n';
    await write({ 'Note.md': `Start\n\n${table}`, 'Files/pipe|x.pdf': '%PDF-1.4\n' });
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Note');
    await page.goto('/#/Note');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await page.getByTestId('editor-content').getByText('cell', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' ![[pipe');
    await page.getByTestId('link-suggestion-file-Files/pipe|x.pdf').click();
    await saved(page);
    const bytes = `Start\n\n${table.replace('| cell |', '| cell [pipe\\|x.pdf](Files/pipe%7Cx.pdf) |')}`;
    await expect.poll(() => read('Note.md')).toBe(bytes);
    // It reads back as the same two-column table with the link in it.
    await page.reload();
    const cells = page.getByTestId('editor-content').locator('td');
    await expect(cells).toHaveCount(2);
    await expect(cells.nth(1).locator('a')).toHaveAttribute('href', 'Files/pipe%7Cx.pdf');
  });
});
