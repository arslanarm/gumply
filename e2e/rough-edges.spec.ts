import { api, expect, test } from './fixtures';

/** #smwaixfp: editor/search rough edges found by @opus-hunter. */

test('``` starts a code block at once and keeps the first word', async ({ page, vault, request }) => {
  const [created] = await vault.seed([{ title: 'Code', content: 'Intro' }]);
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');

  await page.keyboard.type('```');
  await expect(body.locator('pre')).toHaveCount(1);
  await page.keyboard.type('const x = 1;');
  await expect(body.locator('pre')).toHaveText('const x = 1;');

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
  expect((await api.getPage(request, created!.id)).content).toBe('Intro\n\n```\nconst x = 1;\n```');
});

test('the block menu opens beside its block, fully on screen', async ({ page, vault }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const lines = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join('\n\n');
  await vault.seed([{ title: 'Menu', content: lines }]);
  await page.goto('/');

  const last = page.getByTestId('editor-content').getByText('Line 14', { exact: true });
  await last.scrollIntoViewIfNeeded();
  await last.hover();
  await page.getByTestId('block-handle').click();

  const menu = page.getByTestId('block-menu');
  await expect(menu).toBeVisible();
  const m = (await menu.boundingBox())!;
  const b = (await last.boundingBox())!;
  // Inside the viewport, Delete reachable without scrolling the page.
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.y + m.height).toBeLessThanOrEqual(720);
  await expect(page.getByTestId('block-menu-item-delete')).toBeInViewport();
  // Doesn't cover the block it acts on.
  const overlaps = m.y < b.y + b.height && m.y + m.height > b.y;
  expect(overlaps).toBe(false);
});

test('Cmd/Ctrl+K under a resting mouse keeps the first row selected', async ({ page, vault }) => {
  await vault.seed([
    { title: 'One', content: 'a' },
    { title: 'Two', content: 'b' },
    { title: 'Three', content: 'c' },
  ]);
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();

  // Find where the third row appears, then rest the mouse there.
  await page.keyboard.press('ControlOrMeta+k');
  const options = page.getByTestId('quick-switcher').getByRole('option');
  await expect(options).toHaveCount(3);
  const third = (await options.nth(2).boundingBox())!;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-switcher')).toHaveCount(0);
  await page.mouse.move(third.x + 40, third.y + third.height / 2);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'false');

  // A real move does select under the pointer.
  await page.mouse.move(third.x + 60, third.y + third.height / 2);
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
});

test('search snippets read as plain text', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Guide', content: '# Start here\n\nBack to [[Welcome|home]], or **read** the `zebra` notes.' },
  ]);
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('zebra');
  const snippet = page.getByTestId('quick-switcher').locator('.quick-switcher-snippet');
  await expect(snippet).toContainText('Back to home, or read the zebra notes.');
  await expect(snippet).not.toContainText('[[');
  await expect(snippet).not.toContainText('**');
});

test('one click on an existing title edits it at the clicked spot', async ({ page, vault, request }) => {
  const [created] = await vault.seed([{ title: 'Weekly plan', content: 'Body' }]);
  await page.goto('/');
  const heading = page.getByTestId('page-title');
  await expect(heading).toHaveText('Weekly plan');

  // Click right after "Weekly" (between the "y" and the space).
  const offsetX = await heading.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 6);
    return range.getBoundingClientRect().width;
  });
  const box = (await heading.boundingBox())!;
  await page.mouse.click(box.x + offsetX - 1, box.y + box.height / 2);

  const input = page.getByTestId('page-title-input');
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([6, 6]);
  await page.keyboard.type(' team');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('editor-content')).toBeFocused();
  await expect(heading).toHaveText('Weekly team plan');
  await expect.poll(async () => (await api.getPage(request, created!.id)).title).toBe('Weekly team plan');
});
