import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #3zpgenmw (D37): an image's caption keeps escaped characters and entities.
 * markdown-it dropped them inside an image's alt, so `![A\|300](…)` showed
 * "A300" and a caption Gumply wrote as `a\*b\*` came back as "ab". Untouched
 * images keep their bytes; an edited caption reads back as typed.
 */

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#4f46e5"/></svg>',
);

const BODY = 'Intro\n\n![A\\|300](attachments/alt-escapes.svg)\n\n![a\\*b\\* &amp; x \\[1\\]](attachments/alt-escapes.svg)\n\nAfter';

async function seedPage(vault: { seed: (pages: Array<{ title: string; content: string }>) => Promise<Array<{ id: string }>> }) {
  const dir = path.join(E2E_VAULT, 'attachments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'alt-escapes.svg'), SVG);
  const [page] = await vault.seed([{ title: 'Alt escapes', content: BODY }]);
  return page!.id;
}

async function open(page: Page, id: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
  await expect(page.getByTestId('image-block')).toHaveCount(2);
}

async function saved(request: APIRequestContext, id: string, predicate: (content: string) => boolean) {
  let content = '';
  await expect.poll(async () => predicate((content = (await api.getPage(request, id)).content)), { timeout: 10_000 }).toBe(true);
  return content;
}

test('captions show their escaped characters and entities; untouched images keep their bytes', async ({ page, request, vault }) => {
  const id = await seedPage(vault);
  const before = (await api.getPage(request, id)).content;
  await open(page, id);

  const captions = page.getByTestId('image-caption');
  await expect(captions.nth(0)).toHaveValue('A|300');
  await expect(captions.nth(1)).toHaveValue('a*b* & x [1]');

  // An edit elsewhere on the page: both image lines stay exactly as written.
  await page.getByTestId('editor-content').getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' text');
  const after = await saved(request, id, (content) => content.includes('Intro text'));
  expect(after).toBe(before.replace('Intro', 'Intro text'));
});

test('an edited caption is written with the escapes it needs and reads back as typed', async ({ page, request, vault }) => {
  const id = await seedPage(vault);
  await open(page, id);

  await page.getByTestId('image-caption').nth(1).fill('a*b* & x [2] | y');
  const after = await saved(request, id, (content) => content.includes('[2'));
  // The other image is untouched.
  expect(after).toContain('![A\\|300](attachments/alt-escapes.svg)');

  await page.reload();
  await open(page, id);
  await expect(page.getByTestId('image-caption').nth(1)).toHaveValue('a*b* & x [2] | y');
  await expect(page.getByTestId('image-caption').nth(0)).toHaveValue('A|300');
});
