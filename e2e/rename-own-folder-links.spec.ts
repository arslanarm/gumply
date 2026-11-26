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

/** Holds the rename's title PUT for 2 s, so there is time to type while it runs. */
async function holdRename(page: import('@playwright/test').Page) {
  await page.route(
    (url) => url.pathname === '/api/pages/Parent',
    async (route) => {
      const sent = route.request();
      if (sent.method() === 'PUT' && (sent.postDataJSON() as { title?: string } | null)?.title !== undefined) await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    },
  );
}

/** Counts the editor's mounts from now on (a remount adds a new editor-content element). */
async function countMounts(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __mounts: number };
    w.__mounts = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && (node.matches('[data-testid="editor-content"]') || node.querySelector('[data-testid="editor-content"]'))) w.__mounts += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __mounts: number }).__mounts);
}

test('typing during the rename is taken in place (#z9hufufn): the typed text and [[Moved/Sub]] in the file, no remount, no notice; undo never brings the old link back', async ({ page, vault }) => {
  void vault; // resets the vault before and after
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  await holdRename(page);
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');
  const mounts = await countMounts(page);
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed during.');
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  // Right after the answer: keys typed now land too (no remount window).
  await page.keyboard.type(' Just after.');
  const file = path.join(E2E_VAULT, 'Moved.md');
  await expect.poll(() => fs.readFile(file, 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('Just after.');
  const text = await fs.readFile(file, 'utf8');
  expect(text).toContain('See [[Moved/Sub]] here. Typed during. Just after.');
  expect(text).not.toContain('[[Parent/Sub]]');
  expect(await mounts(), 'the editor was never remounted').toBe(0);
  await expect(page.getByTestId('undo-toast').filter({ hasText: 'Your typing during the rename' })).toHaveCount(0);
  // Undo the typing: the rename's change was taken out of the undo history, so the old link never returns.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(2_000); // the undo's autosave
  const undone = await fs.readFile(file, 'utf8');
  expect(undone).not.toContain('[[Parent/Sub]]');
  expect(undone).toContain('[[Moved/Sub]]');
});

test('typing during the rename that the line merge cannot carry (the link line deleted): today\'s reload, the typing in History, and the notice (#z9hufufn fallback)', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'Intro.\n\nSee [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  await holdRename(page);
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('Intro.');
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  // During the rename: the link's paragraph is deleted, and something typed after Intro.
  await page.getByTestId('editor-content').getByText('here.').click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.getByTestId('editor-content').getByText('Intro.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed during.');
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  const notice = page.getByTestId('undo-toast');
  await expect(notice).toContainText('Your typing during the rename was saved in History.', { timeout: 15_000 });
  await notice.hover();
  const text = await fs.readFile(path.join(E2E_VAULT, 'Moved.md'), 'utf8');
  expect(text).toContain('[[Moved/Sub]]');
  expect(text).not.toContain('[[Parent/Sub]]');
  expect(text).not.toContain('Typed during.');
  const items = ((await (await request.get(`${API_URL}/api/history/Moved`)).json()) as { items: Array<{ file: string; reason?: string }> }).items;
  const kept = items.find((item) => item.reason === 'before-reload');
  expect(kept, 'the typed text is in History').toBeDefined();
  expect(await (await request.get(`${API_URL}/api/history/Moved/${encodeURIComponent(kept!.file)}`)).text()).toContain('Typed during.');
});

/** Holds this page's page-list polls (the disk poll), so it can't reload on its own meanwhile. */
async function holdListPolls(page: import('@playwright/test').Page) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/api/pages',
    async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue().catch(() => undefined);
    },
  );
  return release;
}

test('the editor holds an older version than the rewrite started from (a save from another window): no in-place apply, the reload keeps that save (#z9hufufn guard)', async ({ page, context, vault }) => {
  void vault; // resets the vault before and after
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');
  const release = await holdListPolls(page);
  // Another window saves the page; this one doesn't learn of it (its polls are held).
  const other = await context.newPage();
  await other.goto('/#/Parent');
  await other.getByTestId('editor-content').getByText('here.').click();
  await other.keyboard.press('End');
  await other.keyboard.type(' From the other window.');
  const file = path.join(E2E_VAULT, 'Parent.md');
  await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 15_000 }).toContain('From the other window.');
  await other.close();
  // This window renames: the server's rewrite started from the other window's version, not ours.
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  release();
  // The reload shows the other window's text with the rewrite; typing on keeps both.
  await expect(page.getByTestId('editor-content')).toContainText('From the other window.', { timeout: 15_000 });
  await page.getByTestId('editor-content').getByText('From the other window.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Here too.');
  const moved = path.join(E2E_VAULT, 'Moved.md');
  await expect.poll(() => fs.readFile(moved, 'utf8'), { timeout: 15_000 }).toContain('Here too.');
  const text = await fs.readFile(moved, 'utf8');
  expect(text).toContain('[[Moved/Sub]] here. From the other window. Here too.');
});

test('an IME composition open when the rename answers: the apply waits for it, and the composed word lands once (#z9hufufn)', async ({ page, context, vault }) => {
  void vault; // resets the vault before and after
  await fs.mkdir(path.join(E2E_VAULT, 'Parent'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Parent.md'), 'See [[Parent/Sub]] here.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Parent', 'Sub.md'), 'Sub.\n');
  await holdRename(page);
  await page.goto('/#/Parent');
  await expect(page.getByTestId('editor-content')).toContainText('See');
  const cdp = await context.newCDPSession(page);
  await page.getByTestId('page-title').click();
  const input = page.getByTestId('page-title-input');
  await input.fill('Moved');
  await input.press('Enter');
  await page.getByTestId('editor-content').getByText('here.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  // A composition starts while the rename is held, and is still open when its answer arrives.
  await cdp.send('Input.imeSetComposition', { text: 'при', selectionStart: 3, selectionEnd: 3 });
  await expect(page).toHaveURL(/#\/Moved$/, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await cdp.send('Input.insertText', { text: 'привет' }); // commits the composition
  const file = path.join(E2E_VAULT, 'Moved.md');
  await expect.poll(() => fs.readFile(file, 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('привет');
  const text = await fs.readFile(file, 'utf8');
  expect(text).toContain('See [[Moved/Sub]] here. привет');
  expect(text.split('привет').length - 1, 'the composed word once').toBe(1);
  expect(text).not.toContain('[[Parent/Sub]]');
});

test('a plain save a rename\'s link change was merged into: the links follow in place, and no notice (#z9hufufn)', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
  await fs.writeFile(path.join(E2E_VAULT, 'Hub.md'), 'The hub.\n');
  await fs.writeFile(path.join(E2E_VAULT, 'Other.md'), 'Intro.\n\nSee [[Hub]] here.\n');
  await page.goto('/#/Other');
  await expect(page.getByTestId('editor-content')).toContainText('Intro.');
  const release = await holdListPolls(page);
  // Hub is renamed elsewhere (the API); this editor still holds Other's old version and text.
  const renamed = await request.put(`${API_URL}/api/pages/Hub`, { data: { title: 'Hub 2' } });
  expect(renamed.ok()).toBe(true);
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Other.md'), 'utf8'), { timeout: 15_000 }).toContain('[[Hub 2]]');
  await page.getByTestId('editor-content').getByText('Intro.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  const file = path.join(E2E_VAULT, 'Other.md');
  await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 15_000 }).toContain('Typed.');
  release();
  const text = await fs.readFile(file, 'utf8');
  expect(text).toContain('Intro. Typed.');
  expect(text).toContain('See [[Hub 2]] here.');
  await expect(page.getByTestId('undo-toast')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'conflict');
  // The editor took the new link in place: the next save keeps it.
  await page.keyboard.type(' More.');
  await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 15_000 }).toContain('More.');
  expect(await fs.readFile(file, 'utf8')).toContain('See [[Hub 2]] here.');
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
