import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL } from './support/env';

/**
 * D23 (#taqj98u5): attachment links are note-relative.
 * A nested page writes `../attachments/x`, legacy vault-root and Obsidian
 * links still render, and untouched links are written back unchanged.
 */

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#22a06b"/></svg>',
);

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

async function imageLoaded(page: Page, index = 0) {
  const img = page.getByTestId('image-block-img').nth(index);
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
}

test('a nested page writes ../attachments/… and the image still loads after reload', async ({
  page,
  vault,
  request,
}) => {
  const [parent] = await vault.seed([{ title: 'Projects', content: 'Folder page' }]);
  const [child] = await vault.seed([{ title: 'Plan', content: 'Intro', parentId: parent!.id }]);
  await page.goto(`/#/${encodeURIComponent(child!.id)}`);
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');

  await page.keyboard.type('/image');
  const row = page.getByTestId('slash-menu-item-image');
  await expect(row).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), row.click()]);
  await chooser.setFiles({ name: 'd23 pic.svg', mimeType: 'image/svg+xml', buffer: SVG });

  await imageLoaded(page);
  await waitSaved(page);
  const saved = (await api.getPage(request, child!.id)).content;
  // The server sanitises the name (`d23-pic.svg`); %-encoding is unit-tested.
  expect(saved).toMatch(/^Intro\n\n!\[d23-pic(?:-\d+)?\]\(\.\.\/attachments\/d23-pic(?:-\d+)?\.svg\)$/);

  await page.reload();
  await imageLoaded(page);
});

test('legacy vault-root and Obsidian links in a nested page render and stay untouched', async ({
  page,
  vault,
  request,
}) => {
  const upload = await request.post(`${API_URL}/api/attachments`, {
    multipart: { file: { name: 'legacy.svg', mimeType: 'image/svg+xml', buffer: SVG } },
  });
  const attachment = (await upload.json()) as { path: string; name: string };

  const [parent] = await vault.seed([{ title: 'Archive', content: 'Folder page' }]);
  const content = [
    'Intro',
    '',
    `![old](${attachment.path})`,
    '',
    `![[${attachment.name}]]`,
    '',
    `See [${attachment.name}](../${attachment.path}).`,
  ].join('\n');
  const [child] = await vault.seed([{ title: 'Old note', content, parentId: parent!.id }]);

  await page.goto(`/#/${encodeURIComponent(child!.id)}`);
  await imageLoaded(page, 0);
  await imageLoaded(page, 1);
  const card = page.getByTestId('file-attachment').locator('a');
  await expect(card).toHaveAttribute('href', `/api/files/${attachment.path}`);

  await page.getByTestId('editor-content').getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await waitSaved(page);
  expect((await api.getPage(request, child!.id)).content).toBe(
    content.replace('Intro', 'Intro edited'),
  );
});
