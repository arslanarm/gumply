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
});
