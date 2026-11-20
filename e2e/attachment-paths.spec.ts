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

test('Move to… keeps images working: the server rewrites the moved page’s links (#gma39xw2)', async ({
  page,
  vault,
  request,
}) => {
  const upload = await request.post(`${API_URL}/api/attachments`, {
    multipart: { file: { name: 'moved.svg', mimeType: 'image/svg+xml', buffer: SVG } },
  });
  const attachment = (await upload.json()) as { path: string };

  const [parent] = await vault.seed([{ title: 'Projects', content: 'Folder page' }]);
  const [child] = await vault.seed([
    { title: 'Sketch', content: `Intro\n\n![sketch](../${attachment.path})`, parentId: parent!.id },
  ]);
  await page.goto(`/#/${encodeURIComponent(child!.id)}`);
  await imageLoaded(page);

  await page.getByTestId(`page-menu-button-${child!.id}`).click();
  await page.getByTestId(`move-page-${child!.id}`).click();
  await page.getByTestId('move-target-top-level').click();
  await expect(page.getByTestId('undo-toast')).toContainText('Moved to top level');

  // The open page followed the move, shows the image, and the file on disk
  // now links from the top level.
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe('#/Sketch');
  await imageLoaded(page);
  expect((await api.getPage(request, 'Sketch')).content).toBe(
    `Intro\n\n![sketch](${attachment.path})`,
  );

  // Editing afterwards saves cleanly (no conflict with the server's rewrite).
  await page.getByTestId('editor-content').getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  await waitSaved(page);
  expect((await api.getPage(request, 'Sketch')).content).toBe(
    `Intro more\n\n![sketch](${attachment.path})`,
  );

  // Undo moves it back under Projects with ../ again.
  await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () =>
      api.getPage(request, 'Projects/Sketch').then((saved) => saved.content, () => 'not moved yet'),
    )
    .toBe(`Intro more\n\n![sketch](../${attachment.path})`);
});

test('renaming the parent of an open page with a legacy image link reloads it, no conflict', async ({
  page,
  vault,
  request,
}) => {
  const upload = await request.post(`${API_URL}/api/attachments`, {
    multipart: { file: { name: 'legacy2.svg', mimeType: 'image/svg+xml', buffer: SVG } },
  });
  const attachment = (await upload.json()) as { path: string };
  const [parent] = await vault.seed([{ title: 'Projects', content: 'Folder page' }]);
  // Pre-D23 vault-root link: the server makes it note-relative on the move.
  const [child] = await vault.seed([
    { title: 'Plan', content: `Intro\n\n![p](${attachment.path})`, parentId: parent!.id },
  ]);
  await page.goto(`/#/${encodeURIComponent(child!.id)}`);
  await imageLoaded(page);

  await page.getByTestId(`page-item-${parent!.id}`).hover();
  await page.getByTestId(`page-menu-button-${parent!.id}`).click();
  await page.getByTestId(`rename-page-${parent!.id}`).click();
  await page.getByTestId(`page-rename-input-${parent!.id}`).fill('Work');
  await page.keyboard.press('Enter');

  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe('#/Work/Plan');
  await imageLoaded(page);
  await page.getByTestId('editor-content').getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await waitSaved(page);
  expect((await api.getPage(request, 'Work/Plan')).content).toBe(
    `Intro edited\n\n![p](../${attachment.path})`,
  );
});
