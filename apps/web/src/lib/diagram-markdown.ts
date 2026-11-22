/**
 * v0.8 F2: ```mermaid fences in read-only renderers (page previews, board
 * stickies) become `data-mermaid` placeholders holding the source (escaped);
 * `hydrateDiagrams` draws them. Until then, and if drawing fails, the source
 * shows as a code block.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- markdown-it has no bundled types here, as in the other plugins */

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Whether a fence's info string names Mermaid (`mermaid`, `mmd`, `mermaid title=x`). */
export function isMermaidInfo(info: string): boolean {
  const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return language === "mermaid" || language === "mmd";
}

export function diagramMarkdownPlugin(md: any): void {
  const fallback = md.renderer.rules.fence ?? ((tokens: any[], index: number, options: any, env: any, self: any) => self.renderToken(tokens, index, options));
  md.renderer.rules.fence = (tokens: any[], index: number, options: any, env: any, self: any) => {
    const token = tokens[index];
    if (!isMermaidInfo(String(token.info ?? ""))) return fallback(tokens, index, options, env, self);
    const source = String(token.content ?? "").replace(/\n$/, "");
    return `<div class="mermaid-block" data-mermaid="${escapeHtml(source)}" data-diagram-show-source="true"><pre><code>${escapeHtml(source)}</code></pre></div>\n`;
  };
}
