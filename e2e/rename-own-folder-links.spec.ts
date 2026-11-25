import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #ekp8ns58: renaming the OPEN page from its title, when its own body links into its sub-page folder
 * (`[[P/Sub]]`). The server rewrites that link to `[[Q/Sub]]`; the editor must not put the old link
 * back with its next save (D37).
 */
test('renaming a parent from its title keeps the rewrite of its own [[P/Sub]] when typing on', async ({ page, vault }) => {
  void vault; // resets the vault before and after
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

test('typing during the rename: no stale link; the typed text goes to History, and a notice says so (#ekp8ns58 (A))', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
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
  // (A): the held save is not sent (it had the old link); the reload keeps the typing in History and says so.
  const notice = page.getByTestId('undo-toast');
  await expect(notice).toContainText('Your typing during the rename was saved in History.');
  await notice.hover(); // pauses its 8 s timer (the mouse, not the focus)
  const text = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(text, 'the rewrite stays').toContain('[[Moved/Sub]]');
  expect(text).not.toContain('[[Parent/Sub]]');
  expect(text, 'the stale body was not saved').not.toContain('Typed during.');
  const items = ((await (await request.get(`${API_URL}/api/history/Moved`)).json()) as { items: Array<{ file: string; reason?: string }> }).items;
  const kept = items.find((item) => item.reason === 'before-reload');
  expect(kept, 'the typed text is in History').toBeDefined();
  expect(await (await request.get(`${API_URL}/api/history/Moved/${encodeURIComponent(kept!.file)}`)).text()).toContain('Typed during.');
  // Focus is back in the body, at the caret (#ekp8ns58: keyed by the new id). Keys typed in the instant
  // of the remount itself may not reach the page: a known limit for 0.9.6 (no assertion on that instant).
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="editor-content"]')))).toBe(true);
  await page.keyboard.type(' Typed on.');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8'), { timeout: 15_000 }).toContain('here. Typed on.');
  expect(await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8')).toContain('[[Moved/Sub]]');
  // The notice's History button opens it.
  await notice.getByRole('button', { name: 'History' }).click();
  await expect(page.getByTestId('history-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-dialog')).toBeHidden();
  // Typing on in the reloaded page lands, with the rewrite kept.
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed later.');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8'), { timeout: 15_000 }).toContain('Typed later.');
  const later = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(later).toContain('[[Moved/Sub]]');
  expect(later).not.toContain('[[Parent/Sub]]');
});

test('a self-link in the renamed page is never put back to an older form by the editor (@lead)', async ({ page, vault }) => {
  void vault; // resets the vault before and after
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

test('moving the open page deeper or shallower: its relinked ../ links survive typing on (#sj5a2trb, 0.9.5)', async ({ page, vault }) => {
  void vault; // resets the vault before and after
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

test('a save in flight from before the rename: the rename waits for it, so no conflict, and the file has the typing and [[Moved/Sub]] (0.9.x)', async ({ page, vault }) => {
  void vault; // resets the vault before and after
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  // The first content save (not the title PUT) is held for 2.5 s, so the rename starts while it is in flight.
  let held = false;
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => (saveStarted = resolve));
  await page.route(
    (url) => url.pathname === '/api/pages/Parent',
    async (route) => {
      const sent = route.request();
      const body = sent.method() === 'PUT' ? (sent.postDataJSON() as { title?: string; content?: string } | null) : null;
      if (!held && body && body.title === undefined && body.content !== undefined) {
        held = true;
        saveStarted();
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      await route.continue();
    },
  );
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');
  await page.evaluate(() => {
    const states = new Set<string>();
    (window as unknown as { __states: Set<string> }).__states = states;
    setInterval(() => {
      const state = document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state');
      if (state) states.add(state);
    }, 50);
  });
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed before.');
  await started; // the autosave is on its way, with the pre-rename version
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  await page.waitForTimeout(4_000); // the held save has landed (or failed)

  // Pinned on 0.9.x (slot run, 3/3): the rename waits for the save in flight, so it lands first and the
  // rename's rewrite applies on top. No conflict, the typing and [[Moved/Sub]] both in the file.
  const states = await page.evaluate(() => [...(window as unknown as { __states: Set<string> }).__states]);
  expect(states, 'never "changed on disk"').not.toContain('conflict');
  const text = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(text).toContain('Typed before.');
  expect(text).toContain('[[Moved/Sub]]');
  expect(text).not.toContain('[[Parent/Sub]]');
});

test('the reload after the rename never pulls focus into the body when the user is elsewhere (the sidebar) (@lead)', async ({ page, vault }) => {
  void vault; // resets the vault before and after
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');
  // Renamed from the sidebar: focus is there, not in the body.
  await page.getByTestId('page-item-Parent').hover();
  await page.getByTestId('page-menu-button-Parent').click();
  await page.getByTestId('rename-page-Parent').click();
  await page.getByTestId('page-rename-input-Parent').fill('Moved');
  await page.keyboard.press('Enter');
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('[[Moved/Sub]]');
  await expect(page.getByTestId('editor-content')).toContainText('Moved/Sub'); // reloaded
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="editor-content"]'))), 'focus stays out of the body').toBe(false);
});
