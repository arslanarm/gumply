import { createServer, type Server } from 'node:http';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, IMAGE_STUB_PORT } from './support/env';

/**
 * #w6i6e6u7: "Save to vault" on a web image downloads it server-side into
 * attachments/ and rewrites that one link note-relatively (D23).
 */

// A 2×2 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==',
  'base64',
);
const STUB = `http://127.0.0.1:${IMAGE_STUB_PORT}`;

let stub: Server;
let downloads = 0;

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    if (req.url?.startsWith('/pics/sunset.png')) {
      // The browser shows it directly; the server downloads it on save.
      if (req.headers['user-agent']?.includes('Gumply')) downloads += 1;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(PNG);
    } else if (req.url === '/pics/not-an-image.png') {
      // Looks like an image to the browser check, but the server sniffs HTML.
      res.writeHead(200, { 'Content-Type': 'image/png' }).end('<html>nope</html>');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => stub.listen(IMAGE_STUB_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

async function imageLoaded(page: Page) {
  const img = page.getByTestId('image-block-img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
}

test('saves a web image into attachments/ and links it note-relatively; Undo puts the web link back', async ({
  page,
  vault,
  request,
}) => {
  const remote = `${STUB}/pics/sunset.png?w=800`;
  const [parent] = await vault.seed([{ title: 'Trips', content: 'Folder' }]);
  const [doc] = await vault.seed([
    { title: 'Beach', content: `Intro\n\n![Sunset at the beach](${remote})\n\nOutro`, parentId: parent!.id },
  ]);
  await page.goto(`/#/${encodeURIComponent(doc!.id)}`);
  await imageLoaded(page);
  await expect(page.getByTestId('image-block-img')).toHaveAttribute('src', remote);

  const save = page.getByTestId('image-save-to-vault');
  await page.getByTestId('image-block').hover();
  await expect(save).toBeVisible();
  // A double-click downloads once.
  downloads = 0;
  await save.dblclick();

  await expect(page.getByTestId('image-save-to-vault')).toHaveCount(0);
  await imageLoaded(page);
  // sunset.png, or sunset-N.png when an earlier run left one (names dedupe).
  const img = page.getByTestId('image-block-img');
  await expect(img).toHaveAttribute('src', /\/api\/files\/attachments\/sunset(-\d+)?\.png$/);
  const name = (await img.getAttribute('src'))!.split('/').pop()!;
  await waitSaved(page);
  expect((await api.getPage(request, doc!.id)).content).toBe(
    `Intro\n\n![Sunset at the beach](../attachments/${name})\n\nOutro`,
  );
  expect(downloads).toBe(1);
  const file = await request.get(`${API_URL}/api/files/attachments/${name}`);
  expect(file.status()).toBe(200);
  expect(Buffer.from(await file.body())).toEqual(PNG);

  // One undo step restores the web link.
  await page.getByTestId('editor-content').getByText('Outro').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('image-block-img')).toHaveAttribute('src', remote);
  await waitSaved(page);
  expect((await api.getPage(request, doc!.id)).content).toContain(`![Sunset at the beach](${remote})`);
});

test('a failed save shows the error and leaves the link alone', async ({ page, vault, request }) => {
  const remote = `${STUB}/pics/not-an-image.png`;
  const content = `![Broken](${remote})`;
  const [doc] = await vault.seed([{ title: 'Bad image', content }]);
  await page.goto(`/#/${encodeURIComponent(doc!.id)}`);
  await expect(page.getByTestId('image-block')).toBeVisible();

  await page.getByTestId('image-block').hover();
  await page.getByTestId('image-save-to-vault').click();
  await expect(page.getByRole('alert')).toContainText("Couldn't save the image: That address doesn't point to an image");
  // Still the web link, still offering a retry.
  await expect(page.getByTestId('image-save-to-vault')).toHaveText('Save to vault');
  expect((await api.getPage(request, doc!.id)).content).toBe(content);
});

test('the server refuses local addresses that are not explicitly allowed (SSRF)', async ({ request }) => {
  for (const url of [`${API_URL}/api/pages`, 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
    const response = await request.post(`${API_URL}/api/attachments/import`, { data: { url } });
    expect(response.status(), url).toBe(400);
  }
});
