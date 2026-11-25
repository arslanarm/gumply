import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #ekp8ns58: renaming the OPEN page from its title, when its own body links into its sub-page folder
 * (`[[P/Sub]]`). The server rewrites that link to `[[Q/Sub]]`; the editor must not put the old link
 * back with its next save (D37).
 */
test('renaming a parent from its title keeps the rewrite of its own [[P/Sub]] when typing on', async ({ page }) => {
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');

  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');

  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/Moved$/);
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('[[Moved/Sub]]');

  // Type on in the same editor: its save must keep the server's rewrite.
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed after.');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8'), { timeout: 15_000 }).toContain('Typed after.');
  const text = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(text).toContain('[[Moved/Sub]]');
  expect(text).not.toContain('[[Parent/Sub]]');
});

test('typing during the rename: no stale link, and the typed text is kept (in the file or in History on the renamed page)', async ({ page, request }) => {
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  // The title PUT is held for 2 s, so there is time to type while it runs.
  await page.route(
    (url) => url.pathname === '/api/pages/Parent',
    async (route) => {
      const sent = route.request();
      if (sent.method() === 'PUT' && (sent.postDataJSON() as { title?: string } | null)?.title !== undefined) await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    },
  );
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed during.');
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('[[Moved/Sub]]');
  await page.waitForTimeout(3_000); // any late save has had its chance
  const text = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(text, 'the rewrite stays').toContain('[[Moved/Sub]]');
  expect(text).not.toContain('[[Parent/Sub]]');
  if (!text.includes('Typed during.')) {
    // @opus-editor: kept in History as "Before reload", on the renamed page (the old id redirected).
    const items = ((await (await request.get(`${API_URL}/api/history/Moved`)).json()) as { items: Array<{ file: string; reason?: string }> }).items;
    const kept = items.find((item) => item.reason === 'before-reload');
    expect(kept, 'the typed text is in History').toBeDefined();
    expect(await (await request.get(`${API_URL}/api/history/Moved/${encodeURIComponent(kept!.file)}`)).text()).toContain('Typed during.');
  }
});

test('a self-link in the renamed page is never put back to an older form by the editor (@lead)', async ({ page }) => {
  await fs.writeFile(path.join(E2E_VAULT, 'Selfy.md'), 'Me: [[Selfy]] and [[Selfy#Part|part]].\n\n## Part\n');
  await page.goto('/#/Selfy');
  await expect(page.getByTestId('editor-content')).toContainText('Me:');
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Selfish');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/Selfish$/);
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Selfish.md'), 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('Me:');
  // Whatever the server did with the self-links (#h7j39kka decides), the editor's save must keep it.
  const server = (await fs.readFile(path.join(E2E_VAULT, 'Selfish.md'), 'utf8')).split('\n')[0]!;
  await page.getByTestId('editor-content').getByText('Me:').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Selfish.md'), 'utf8'), { timeout: 15_000 }).toContain('Typed.');
  expect((await fs.readFile(path.join(E2E_VAULT, 'Selfish.md'), 'utf8')).split('\n')[0]).toBe(`${server} Typed.`);
});

test('moving the open page deeper or shallower: its relinked ../ links survive typing on (#sj5a2trb, 0.9.5)', async ({ page }) => {
  await fs.mkdir(path.join(E2E_VAULT, 'Notes'), { recursive: true });
  await fs.mkdir(path.join(E2E_VAULT, 'Other'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Other', 'c.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await fs.writeFile(path.join(E2E_VAULT, 'Notes.md'), 'Notes.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Notes', 'Trip.md'), 'Trip.\n\n![c](../Other/c.png)\n');
  await page.goto('/#/Notes%2FTrip');
  await expect(page.getByTestId('editor-content')).toContainText('Trip.');
  await page.getByTestId('page-menu-button-Notes/Trip').click();
  await page.getByTestId('move-page-Notes/Trip').click();
  await page.getByTestId('move-target-top-level').click();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe('#/Trip');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Trip.md'), 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('![c](Other/c.png)');
  await page.getByTestId('editor-content').getByText('Trip.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Trip.md'), 'utf8'), { timeout: 15_000 }).toContain('Typed.');
  const text = await fs.readFile(path.join(E2E_VAULT, 'Trip.md'), 'utf8');
  expect(text).toContain('![c](Other/c.png)');
  expect(text).not.toContain('../Other/c.png');
});
