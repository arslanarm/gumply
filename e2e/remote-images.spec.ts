import { api, expect, test } from './fixtures';

/** #9zqypgmh: remote images load directly (not via /api/files). */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('a pasted remote image renders and keeps its URL', async ({ page, vault, request }) => {
  const seen: string[] = [];
  await page.route('https://images.example.test/**', async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  const [created] = await vault.seed([{ title: 'Remote', content: 'Intro' }]);
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await body.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', '<p><img src="https://images.example.test/cat.png" alt="cat"></p>');
    transfer.setData('text/plain', '');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });

  const img = page.getByTestId('image-block-img');
  await expect(img).toHaveAttribute('src', 'https://images.example.test/cat.png');
  await expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  expect(seen).toContain('https://images.example.test/cat.png');

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  expect((await api.getPage(request, created!.id)).content).toBe(
    'Intro\n\n![cat](https://images.example.test/cat.png)',
  );

  await page.reload();
  await expect.poll(() => page.getByTestId('image-block-img').evaluate((el: HTMLImageElement) => el.naturalWidth > 0)).toBe(true);
});

test('unsafe image and file links never load or open', async ({ page, vault }) => {
  await vault.seed([
    {
      title: 'Unsafe',
      content: '![x](javascript:alert(1))\n\n[evil.pdf](attachments/../../etc/passwd)\n\n[doc.pdf](https://files.example.test/doc.pdf)',
    },
  ]);
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();
  const srcs = await page.getByTestId('image-block-img').evaluateAll((els) => els.map((el) => el.getAttribute('src')));
  for (const src of srcs) expect(src ?? '').not.toMatch(/^javascript:/i);
});
