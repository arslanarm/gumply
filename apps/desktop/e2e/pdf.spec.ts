import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * G2 (#dhf34uv5): File → Export as PDF… prints the open page in main
 * (printToPDF in a hidden window on its own session), then saves it. Build
 * first: `npm run build -w @gumply/desktop`.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.GUMPLY_DESKTOP_SHOTS;

test.skip(
  process.platform === 'linux' && (process.env.GUMPLY_DESKTOP_HEADLESS !== '1' || !process.env.GUMPLY_TEST_DBUS),
  'Run via `npm run desktop:test` (virtual display + private D-Bus); refusing to touch the real desktop session.',
);

const SESSION_VARS = new Set(['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'DESKTOP_SESSION', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']);

/** A real 40×30 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);

let scratch: string;

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gumply-desktop-pdf-'));
});
test.afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function isolatedEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('XDG_') && !SESSION_VARS.has(key)) base[key] = value;
  }
  const home = join(scratch, 'home');
  const dirs = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.env.GUMPLY_TEST_DBUS) base.DBUS_SESSION_BUS_ADDRESS = process.env.GUMPLY_TEST_DBUS;
  return { ...base, ...dirs };
}

const rows = Array.from({ length: 120 }, (_, index) => `| ${index + 1} | Row ${index + 1} | ${'note '.repeat(6).trim()} |`).join('\n');
const REPORT = [
  '---',
  'cover: gradient:ocean',
  '---',
  '',
  '## Summary',
  '',
  '![[chart.png]]',
  '',
  'Energy: $E = mc^2$.',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  '$$',
  '',
  '```mermaid',
  'graph LR; Plan-->Build-->Ship',
  '```',
  '',
  '| # | Name | Notes |',
  '| --- | --- | --- |',
  rows,
  '',
].join('\n');

test('File → Export as PDF… saves a multi-page PDF of the open page, with nothing fetched from outside', async () => {
  test.setTimeout(180_000);
  const vault = join(scratch, 'vault');
  const downloads = join(scratch, 'downloads');
  mkdirSync(vault, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(vault, 'chart.png'), PNG);
  writeFileSync(join(vault, 'Report.md'), REPORT);
  const printScratchBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('gumply-print-')).length;

  const app = await electron.launch({
    args: ['--ozone-platform=x11', appDir],
    env: {
      ...isolatedEnv(),
      GUMPLY_DESKTOP_VAULT: vault,
      GUMPLY_DESKTOP_USER_DATA: join(scratch, 'user-data'),
      GUMPLY_DESKTOP_DOWNLOAD_DIR: downloads,
      GUMPLY_DESKTOP_PORT: String(Number(process.env.GUMPLY_DESKTOP_PORT ?? 11010) + 2),
    },
  });
  try {
    const window = await app.firstWindow({ timeout: 60_000 });
    await expect(window.getByTestId('page-item-Report')).toBeVisible({ timeout: 30_000 });
    await window.getByTestId('page-item-Report').click();
    await expect(window.getByTestId('editor-content')).toContainText('Summary');

    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('export-pdf')!.click());
    await expect(window.getByTestId('export-dialog')).toContainText('Export as PDF');
    await window.getByTestId('export-size-A4').check();
    await window.getByTestId('export-confirm').click();

    const pdfPath = join(downloads, 'Report.pdf');
    await expect.poll(() => existsSync(pdfPath), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => readFileSync(pdfPath).length, { timeout: 10_000 }).toBeGreaterThan(1000);
    const pdf = readFileSync(pdfPath);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    console.log(`[pdf] ${pages} pages, ${pdf.length} bytes`);
    expect(pages).toBeGreaterThan(1);

    // Nothing outside the document was requested by the print window.
    expect(await app.evaluate(() => (globalThis as { __gumplyPrintBlocked?: string[] }).__gumplyPrintBlocked ?? [])).toEqual([]);
    // The hand-off file is gone; nothing else was downloaded.
    expect(readdirSync(downloads)).toEqual(['Report.pdf']);
    await expect.poll(() => readdirSync(tmpdir()).filter((name) => name.startsWith('gumply-print-')).length).toBe(printScratchBefore);

    if (shots) {
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, 'g2-report.pdf'), pdf);
    }
  } finally {
    await app.close().catch(() => undefined);
  }
});
