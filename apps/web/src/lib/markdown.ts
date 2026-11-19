/**
 * TipTap's Markdown serializer escapes brackets in plain text, so a body that
 * contains `[[Page]]` is written back as `\[\[Page\]\]`. That breaks wikilink
 * resolution (and the server's rename rewrite, D12) until M2 renders links as
 * nodes. Unescape *pairs* only: single brackets like `array[0]` stay escaped.
 */
export function normalizeEditorMarkdown(markdown: string): string {
  return markdown.replace(/\\\[\\\[/g, "[[").replace(/\\\]\\\]/g, "]]");
}
