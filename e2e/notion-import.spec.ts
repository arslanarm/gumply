import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 B2 (#znyztw3t): importing the lorem Notion fixture through the API
 * makes pages that open in the editor, with their image shown and the
 * database links turned into embeds. The UI for it is B4.
 */

const FIXTURE = fileURLToPath(new URL('../packages/core/test/fixtures/notion/basic/', import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function fixtureZip(): Promise<Buffer> {
  const files: Zippable = {};
  for (const file of await walk(FIXTURE)) files[path.relative(FIXTURE, file).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(file));
  return Buffer.from(zipSync(files));
}

test('a Notion export imports into "Notion import" and its pages open with their image and database embeds', async ({ page, request, vault }) => {
  void vault;
  const started = await request.post('/api/import/notion', {
    multipart: { file: { name: 'Export.zip', mimeType: 'application/zip', buffer: await fixtureZip() } },
  });
  expect(started.status()).toBe(202);
  const { id } = (await started.json()) as { id: string };
  await expect
    .poll(async () => ((await (await request.get(`/api/import/${id}`)).json()) as { state: string }).state, { timeout: 15_000 })
    .toBe('done');

  await page.goto(`/#/${encodeURIComponent('Notion import/Private & Shared/Test page')}`);
  const body = page.getByTestId('editor-content');
  await expect(body).toContainText('Perspiciatis corrupti');
  // The repeated "# Test page" heading was dropped: the title is the file name.
  await expect(body.locator('h1')).toHaveCount(0);
  const image = body.locator('img').first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1968);
  // The page file is what the planner wrote (the golden), untouched by opening it.
  const file = path.join(E2E_VAULT, 'Notion import/Private & Shared/Test page.md');
  expect(await fs.readFile(file, 'utf8')).toContain('![[DB.base]]');
});

test('an imported page survives an edit elsewhere byte for byte (its `ratione.\\` line included, #6wnxxk4y)', async ({ page, request, vault }) => {
  void vault;
  const started = await request.post('/api/import/notion', {
    multipart: { file: { name: 'Export.zip', mimeType: 'application/zip', buffer: await fixtureZip() } },
  });
  const { id } = (await started.json()) as { id: string };
  await expect
    .poll(async () => ((await (await request.get(`/api/import/${id}`)).json()) as { state: string }).state, { timeout: 15_000 })
    .toBe('done');
  // The vault may still hold an earlier import: use the folder this one made.
  const { folder } = (await (await request.get(`/api/import/${id}`)).json()) as { folder: string };
  const file = path.join(E2E_VAULT, folder, 'Private & Shared/Test page.md');
  const imported = await fs.readFile(file, 'utf8');
  expect(imported).toContain('ratione.\\\n');
  await page.goto(`/#/${encodeURIComponent(`${folder}/Private & Shared/Test page`)}`);
  await page.getByTestId('editor-content').getByText('Ullam rerum eos harum', { exact: false }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  // Only the edited paragraph changed (End goes to the end of the wrapped
  // visual line, so where " X" lands inside it doesn't matter); every other
  // line, the trailing-backslash one included, is byte-identical.
  await expect.poll(async () => (await fs.readFile(file, 'utf8')).includes(' X')).toBe(true);
  const before = imported.split('\n');
  const after = (await fs.readFile(file, 'utf8')).split('\n');
  expect(after).toHaveLength(before.length);
  const edited = before.findIndex((line) => line.startsWith('Ullam rerum'));
  after.forEach((line, index) => {
    if (index === edited) expect(line.replace(' X', '')).toBe(before[index]);
    else expect(line, `line ${index + 1}`).toBe(before[index]);
  });
});
