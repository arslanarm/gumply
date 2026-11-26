import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #x8uddj3z (visual QA 4): the Notion import's report is long, so on a narrow window (or a short
 * one) its Close and "Open folder" buttons were below the fold, found only by scrolling past every
 * list. They stay at the dialog's bottom edge now. The synthetic export is the repo's fixture.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const FIXTURE = fileURLToPath(new URL('../packages/core/test/fixtures/notion/synthetic/', import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function zip(): Promise<Buffer> {
  const files: Zippable = {};
  for (const file of await walk(FIXTURE)) files[path.relative(FIXTURE, file).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(file));
  return Buffer.from(zipSync(files));
}

async function removeImports() {
  for (const dir of [E2E_VAULT, path.join(E2E_VAULT, 'attachments')]) {
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) if (name.startsWith('Notion import')) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

test.beforeEach(removeImports);
test.afterEach(removeImports);
test.use({ viewport: { width: 420, height: 800 } });

test('the import report keeps Close and Open folder on screen on a narrow window (ru)', async ({ page, vault }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await vault.seed([{ title: 'Home', content: 'Hi' }]);
  await page.goto('/#/Home');
  await page.getByTestId('editor-content').waitFor();
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('import notion');
  await page.getByTestId('search-import-notion').click();
  await page.getByTestId('notion-import-file').setInputFiles({ name: 'Export-1234.zip', mimeType: 'application/zip', buffer: await zip() });
  await page.getByTestId('notion-import-start').click();
  await expect(page.getByTestId('notion-import-report')).toBeVisible({ timeout: 30_000 });

  const dialog = page.getByTestId('notion-import');
  // The report is longer than the window: the dialog scrolls.
  expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  for (const id of ['notion-import-open', 'notion-import-close']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.y + box.height, `${id} is on screen without scrolling`).toBeLessThanOrEqual(800);
    const dialogBox = (await dialog.boundingBox())!;
    expect(box.y + box.height, `${id} is inside the dialog`).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
  }
  // Still there with the report scrolled to its middle, and the button works from there.
  await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
  const open = (await page.getByTestId('notion-import-open').boundingBox())!;
  expect(open.y + open.height).toBeLessThanOrEqual(800);
});
