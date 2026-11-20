import { test, expect, type Vault } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#4f46e5"/></svg>',
);

async function openPage(page: import('@playwright/test').Page, vault: Vault) {
  const [seeded] = await vault.seed([{ title: 'Attachments', content: '' }]);
  await page.goto('/');
  await expectPageTitle(page, 'Attachments');
  const editor = page.getByTestId('editor-content');
  await expect(editor).toBeVisible();
  return { seeded, editor };
}

async function pickFromSlash(
  page: import('@playwright/test').Page,
  kind: 'image' | 'file',
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const editor = page.getByTestId('editor-content');
  await editor.click();
  await page.keyboard.type(`/${kind}`);
  const row = page.getByTestId(`slash-menu-item-${kind}`);
  await expect(row).toBeVisible();

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), row.click()]);
  await chooser.setFiles(file);
}

/**
 * Q1c attachments (D18/D19): `/image` and `/file` pickers, paste, drop,
 * Markdown round-trip, reload, the file card link, and `/api/files` guards.
 */
test.describe('attachments', () => {
  test('/image uploads, renders, saves as Markdown and survives reload', async ({
    page,
    vault,
    request,
  }) => {
    const { seeded } = await openPage(page, vault);

    await pickFromSlash(page, 'image', {
      name: 'q1-e2e.svg',
      mimeType: 'image/svg+xml',
      buffer: SVG,
    });

    const image = page.getByTestId('image-block');
    await expect(image).toBeVisible();
    const img = page.getByTestId('image-block-img');
    await expect(img).toHaveAttribute('src', /\/api\/files\/attachments\/q1-e2e(?:-\d+)?\.svg$/);
    await expect(img).toBeVisible();

    await page.getByTestId('image-caption').fill('My caption');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });

    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(seeded.id)}`)
    ).json();
    expect(saved.content).toMatch(/!\[My caption\]\(attachments\/q1-e2e(?:-\d+)?\.svg\)/);

    await page.reload();
    await expect(page.getByTestId('image-block')).toBeVisible();
    await expect(page.getByTestId('image-block-img')).toBeVisible();
    await expect(page.getByTestId('image-caption')).toHaveValue('My caption');
  });

  test('/file uploads a card, links to /api/files and saves as Markdown', async ({
    page,
    vault,
    request,
  }) => {
    const { seeded } = await openPage(page, vault);

    await pickFromSlash(page, 'file', {
      name: 'brief.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from an attachment'),
    });

    const card = page.getByTestId('file-attachment');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-name', /brief(?:-\d+)?\.txt/);
    const link = card.locator('a');
    await expect(link).toHaveAttribute('href', /\/api\/files\/attachments\/brief(?:-\d+)?\.txt$/);

    // The card link opens the served file in a new tab.
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await expect.poll(() => popup.url()).toContain('/api/files/attachments/brief');
    await popup.close();

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(seeded.id)}`)
    ).json();
    expect(saved.content).toMatch(/\[brief(?:-\d+)?\.txt\]\(attachments\/brief(?:-\d+)?\.txt\)/);

    await page.reload();
    await expect(page.getByTestId('file-attachment')).toBeVisible();
    await expect(page.getByTestId('file-attachment').locator('a')).toHaveAttribute(
      'href',
      /\/api\/files\/attachments\/brief/,
    );
  });

  test('pasting and dropping image files uploads and renders after reload', async ({
    page,
    vault,
  }) => {
    await openPage(page, vault);
    const editor = page.getByTestId('editor-content');

    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#16a34a"/></svg>'],
          'pasted.svg',
          { type: 'image/svg+xml' },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.getByTestId('image-block')).toHaveCount(1);

    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#dc2626"/></svg>'],
          'dropped.svg',
          { type: 'image/svg+xml' },
        ),
      );
      return data;
    });
    // Drop inside the editor bounds: ProseMirror ignores coords outside it.
    const box = await editor.boundingBox();
    expect(box).not.toBeNull();
    await editor.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientX: box!.x + 40,
      clientY: box!.y + 20,
    });
    await expect(page.getByTestId('image-block')).toHaveCount(2);

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    await page.reload();
    await expect(page.getByTestId('image-block')).toHaveCount(2);
    const sources = await page
      .getByTestId('image-block-img')
      .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
    expect(sources.some((src) => src.includes('pasted'))).toBe(true);
    expect(sources.some((src) => src.includes('dropped'))).toBe(true);
  });

  test('/api/files refuses traversal, hidden directories and missing files', async ({
    request,
  }) => {
    for (const path of [
      '../secret.txt',
      '.trash/t1/secret.txt',
      '.gumply/state.json',
      'attachments/../secret.txt',
      'missing.png',
    ]) {
      const response = await request.get(`${API_URL}/api/files/${encodeURIComponent(path)}`);
      expect(response.status(), path).toBe(404);
    }
  });
});
