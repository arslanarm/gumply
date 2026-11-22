import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { zipSync, type Zippable } from 'fflate';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * v0.8 B4 (spec/notion-import §8): "Import from Notion…" through the UI:
 * pick the export zip, follow the import, read the report, open the folder.
 * The import itself is B2's (e2e/notion-import.spec.ts covers its output).
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
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

const zipFile = async () => ({ name: 'Export-1234.zip', mimeType: 'application/zip', buffer: await fixtureZip() });

async function openFromCmdK(page: Page) {
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('import notion');
  await page.getByTestId('search-import-notion').click();
  await expect(page.getByTestId('notion-import')).toBeVisible();
}

async function importZip(page: Page) {
  await page.getByTestId('notion-import-file').setInputFiles(await zipFile());
  await expect(page.getByTestId('notion-import-drop')).toContainText('Export-1234.zip');
  await page.getByTestId('notion-import-start').click();
  await expect(page.getByTestId('notion-import-report')).toBeVisible({ timeout: 20_000 });
}

/** Imports leave folders the vault reset may keep (attachments/ too): remove them. */
async function removeImports() {
  for (const dir of [E2E_VAULT, path.join(E2E_VAULT, 'Work'), path.join(E2E_VAULT, 'attachments')]) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (name.startsWith('Notion import')) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
  await fs.rm(path.join(E2E_VAULT, 'Work'), { recursive: true, force: true });
}

test.beforeEach(removeImports);
test.afterEach(removeImports);

test.describe('Import from Notion (B4)', () => {
  test('from Cmd+K: pick the zip, see the report, open the new folder; a second import goes beside it', async ({ page, vault }) => {
    test.setTimeout(90_000);
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await page.goto('/#/Home');
    await expectPageTitle(page, 'Home');

    await openFromCmdK(page);
    // Nothing to import yet; the target is the vault's top level.
    await expect(page.getByTestId('notion-import-start')).toBeDisabled();
    await expect(page.getByTestId('notion-import-target')).toHaveValue('');
    await importZip(page);

    await expect(page.getByTestId('notion-import-folder')).toHaveText('Imported into “Notion import”');
    await expect(page.getByTestId('notion-import-counts')).toContainText(/\d+ pages?/);
    await expect(page.getByTestId('notion-import-lost')).toContainText('Database views');
    // B3 (#cwi22mc6): each database, the views made and its property types.
    const databases = page.getByTestId('notion-import-databases');
    await expect(databases).toContainText('Boardview: a table view in Notion\'s column order, and a board grouped by Status');
    await expect(databases).toContainText('DB: a table view in Notion\'s column order. Properties: Number (Number)');
    await expect(page.getByTestId('notion-import-report')).not.toContainText('Your earlier import is unchanged.');
    // The report also went into the folder.
    await expect.poll(() => fs.access(path.join(E2E_VAULT, 'Notion import', 'Import report.md')).then(() => true, () => false)).toBe(true);

    await page.getByTestId('notion-import-open').click();
    await expect(page.getByTestId('notion-import')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/Notion%20import$/);
    await expect(page.getByTestId('page-item-Notion import')).toBeVisible();

    // Again: a new folder, and the first one stays as it was.
    const first = await fs.readFile(path.join(E2E_VAULT, 'Notion import', 'Import report.md'), 'utf8');
    await openFromCmdK(page);
    await importZip(page);
    await expect(page.getByTestId('notion-import-folder')).toHaveText('Imported into “Notion import 2”');
    await expect(page.getByTestId('notion-import-report')).toContainText('Your earlier import is unchanged.');
    expect(await fs.readFile(path.join(E2E_VAULT, 'Notion import', 'Import report.md'), 'utf8')).toBe(first);
    await page.getByTestId('notion-import-close').click();
    await expect(page.getByTestId('notion-import')).toHaveCount(0);
  });

  test('from a row menu: imports into that folder', async ({ page, vault }) => {
    test.setTimeout(90_000);
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await fs.mkdir(path.join(E2E_VAULT, 'Work'), { recursive: true });
    await page.goto('/#/Home');
    await expect(page.getByTestId('page-item-Work')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('page-menu-button-Work').click();
    await page.getByTestId('import-notion-Work').click();
    await expect(page.getByTestId('notion-import-target')).toHaveValue('Work');
    await importZip(page);
    await expect(page.getByTestId('notion-import-folder')).toHaveText('Imported into “Notion import”');
    await expect.poll(() => fs.access(path.join(E2E_VAULT, 'Work', 'Notion import', 'Import report.md')).then(() => true, () => false)).toBe(true);
  });

  test('in Russian, Import report.md is written in Russian (#n86gnptg)', async ({ page, vault }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await fs.mkdir(path.join(E2E_VAULT, 'Work'), { recursive: true });
    await page.goto('/#/Home');
    await expect(page.getByTestId('page-item-Work')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('page-menu-button-Work').click();
    await page.getByTestId('import-notion-Work').click();
    await importZip(page);
    await expect(page.getByTestId('notion-import-databases')).toContainText('таблица');
    const golden = await fs.readFile(new URL('../packages/core/test/fixtures/notion/reports/basic.ru.md', import.meta.url), 'utf8');
    await expect
      .poll(() => fs.readFile(path.join(E2E_VAULT, 'Work', 'Notion import', 'Import report.md'), 'utf8').catch(() => ''))
      .toBe(golden.replace('Импортировано в `Notion import`.', 'Импортировано в `Work/Notion import`.'));
  });

  test('plain-words errors: not a zip, not an export, an import already running; Try again goes back', async ({ page, vault }) => {
    await vault.seed([{ title: 'Home', content: 'Hi' }]);
    await page.goto('/#/Home');
    await expectPageTitle(page, 'Home');
    await openFromCmdK(page);

    // A file that isn't a zip is refused before anything is sent.
    await page.getByTestId('notion-import-file').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Hi\n') });
    await expect(page.getByTestId('notion-import-file-error')).toHaveText('That isn\'t a zip file. Pick the .zip Notion downloaded.');
    await expect(page.getByTestId('notion-import-start')).toBeDisabled();

    // A broken zip: the server says no, in plain words.
    await page.getByTestId('notion-import-file').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('this is not a zip') });
    await page.getByTestId('notion-import-start').click();
    // The server takes it (202) and the job fails: our plain words, the server's reason as a detail.
    await expect(page.getByTestId('notion-import-error')).toHaveText('The import didn\'t finish: Gumply couldn\'t use this file as a Notion “Markdown & CSV” export.', { timeout: 15_000 });
    await expect(page.getByTestId('notion-import-failed')).toContainText('Details:');
    await page.getByTestId('notion-import-retry').click();
    await expect(page.getByTestId('notion-import-drop')).toBeVisible();

    // Another import is running (the server answers 409).
    await page.route('**/api/import/notion', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Import 7f3a is already running' }) }),
    );
    await page.getByTestId('notion-import-file').setInputFiles(await zipFile());
    await page.getByTestId('notion-import-start').click();
    await expect(page.getByTestId('notion-import-error')).toHaveText('An import is already running in this vault. Wait for it to finish, then try again.');
    // Nothing was written.
    await expect(fs.access(path.join(E2E_VAULT, 'Notion import'))).rejects.toThrow();

    // Too large (413): the limit comes from the shared constant.
    await page.getByTestId('notion-import-retry').click();
    await page.unroute('**/api/import/notion');
    await page.route('**/api/import/notion', (route) =>
      route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'The export is too large (max 1 GB)' }) }),
    );
    await page.getByTestId('notion-import-file').setInputFiles(await zipFile());
    await page.getByTestId('notion-import-start').click();
    await expect(page.getByTestId('notion-import-error')).toHaveText('That file is too large to import (over 1 GB).');
  });
});
