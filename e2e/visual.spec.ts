import { test, expect } from './fixtures';

/**
 * Visual regressions the functional suite missed (Q1a, `spec/q1-quality`).
 * These read computed style, so a CSS-only regression cannot slip through.
 */
test.describe('editor visual quality', () => {
  // Q1a (#aspp2x4n): the previous build drew a 2px solid outline on the editor
  // (and 3px on its host) — the owner's "whole document lights up" symptom.
  test('the editor has no document outline or border when focused', async ({ page, vault }) => {
    await vault.seed([{ title: 'Outline check', content: 'Some body text.' }]);

    await page.goto('/');
    const editor = page.getByTestId('editor-content');
    await expect(editor).toBeVisible();

    const read = () =>
      editor.evaluate((element) => {
        const styles = getComputedStyle(element);
        const host = element.parentElement;
        const hostStyles = host ? getComputedStyle(host) : null;
        return {
          // `outline-width` can be non-zero while `outline-style: none`
          // draws nothing, so assert the visible property, not the width.
          outlineStyle: styles.outlineStyle,
          hostOutlineStyle: hostStyles?.outlineStyle ?? 'none',
          borderTopWidth: styles.borderTopWidth,
          borderRightWidth: styles.borderRightWidth,
          borderBottomWidth: styles.borderBottomWidth,
          borderLeftWidth: styles.borderLeftWidth,
          hostBorderTopWidth: hostStyles?.borderTopWidth ?? '0px',
        };
      });

    // Mouse focus (what the owner did) and keyboard focus must both be bare:
    // focus is shown by the caret, never a box around the whole document.
    await editor.click();
    expect(await read()).toEqual({
      outlineStyle: 'none',
      hostOutlineStyle: 'none',
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      hostBorderTopWidth: '0px',
    });

    await editor.focus();
    expect(await read()).toEqual({
      outlineStyle: 'none',
      hostOutlineStyle: 'none',
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      hostBorderTopWidth: '0px',
    });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`checked to-dos are struck through and muted on the text node (${theme})`, async ({
      page,
      vault,
    }) => {
      // #amh3bgc5: the wrapper decorated the text visually, but its <p> computed
      // `none`; assert the text node itself, as the UX audit did.
      await vault.seed([
        { title: 'To-do styles', content: '- [x] Done task\n- [ ] Open task' },
      ]);
      await page.addInitScript(
        ({ key, value }) => window.localStorage.setItem(key, value),
        { key: 'gumply:theme', value: theme },
      );
      await page.goto('/');
      const body = page.getByTestId('editor-content');
      await expect(body).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const tokens = await page.evaluate(() => {
        const styles = getComputedStyle(document.documentElement);
        const resolve = (name: string) => {
          const probe = document.createElement('span');
          probe.style.color = styles.getPropertyValue(name).trim();
          document.body.appendChild(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return { muted: resolve('--muted'), text: resolve('--text') };
      });

      const checked = body.locator('li[data-checked="true"] p').first();
      const unchecked = body.locator('li[data-checked="false"] p').first();
      await expect(checked).toHaveText('Done task');
      await expect(unchecked).toHaveText('Open task');

      const styleOf = (locator: typeof checked) =>
        locator.evaluate((element) => {
          const styles = getComputedStyle(element);
          return { decoration: styles.textDecorationLine, color: styles.color };
        });

      expect(await styleOf(checked)).toEqual({
        decoration: 'line-through',
        color: tokens.muted,
      });
      expect(await styleOf(unchecked)).toEqual({
        decoration: 'none',
        color: tokens.text,
      });
    });
  }
});
