import { test, expect } from './fixtures';
import { createPage, listPages } from './support/api';

/**
 * #dh3jdu7g (from trial-main21's board-engine:811, which opened a board another spec had left behind):
 * every test starts from an empty vault, even one that doesn't ask for the `vault` fixture. These two run in
 * file order and neither names `vault`: the first leaves a page, the second must not see it. Invented names.
 */
test('a test that never names `vault` may still create a page', async ({ request }) => {
  await createPage(request, { title: 'Leftover board notes' });
  expect((await listPages(request)).map((page) => page.title)).toContain('Leftover board notes');
});

test('the next test starts from an empty vault anyway', async ({ request }) => {
  expect((await listPages(request)).map((page) => page.title)).not.toContain('Leftover board notes');
});
