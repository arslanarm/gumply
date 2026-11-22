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

async function fixtureZip(dir = FIXTURE): Promise<Buffer> {
  const files: Zippable = {};
  for (const file of await walk(dir)) files[path.relative(dir, file).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(file));
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

// v0.8 B3 (#cwi22mc6): databases arrive as a .base view over typed row pages.
test('a Notion database opens as a table in Notion\'s column order, with a board, and its rows have typed properties', async ({ page, request, vault }) => {
  void vault;
  const zip = await fixtureZip(fileURLToPath(new URL('../packages/core/test/fixtures/notion/databases/', import.meta.url)));
  const started = await request.post('/api/import/notion', { multipart: { file: { name: 'Export.zip', mimeType: 'application/zip', buffer: zip } } });
  expect(started.status()).toBe(202);
  const { id } = (await started.json()) as { id: string };
  await expect
    .poll(async () => ((await (await request.get(`/api/import/${id}`)).json()) as { state: string }).state, { timeout: 15_000 })
    .toBe('done');

  // Earlier tests' imports may still be there: use the folder this one got.
  const job = (await (await request.get(`/api/import/${id}`)).json()) as { folder: string };
  const folder = `${job.folder}/Private & Shared/Projects`;
  await page.goto(`/#/${encodeURIComponent(`${folder}/Tasks.base`)}`);
  const table = page.getByTestId('base-table');
  await expect(table.locator('.base-th-label')).toHaveText(['Name', 'Due', 'Priority 1 5', 'Done', 'Tags', 'Owner', 'Notes']);
  await expect(table.locator('.base-title-text')).toHaveCount(3);
  await page.getByTestId('base-tab-Board').click();
  await expect(page.getByTestId('base-kanban').locator('.base-kanban-title > span:first-child')).toHaveText(['Todo', 'Doing', 'Done']);

  // Typed: the vault knows the new keys' types, and a row shows them.
  const properties = (await (await request.get('/api/properties')).json()) as Array<{ key: string; type: string }>;
  const typeOf = (key: string) => properties.find((item) => item.key === key)?.type;
  // (`Tags` gets no stored type: it's the note's tags, #ippqkgus.)
  expect([typeOf('Due'), typeOf('Priority 1 5'), typeOf('Done'), typeOf('Owner'), typeOf('Estimate')]).toEqual(['date', 'number', 'checkbox', 'multitext', 'datetime']);
  await page.goto(`/#/${encodeURIComponent(`${folder}/Tasks/Write spec`)}`);
  await expect(page.getByTestId('property-row-Done').getByRole('checkbox')).toBeChecked();
  await expect(page.getByTestId('editor-content')).toContainText('First draft.');
});
