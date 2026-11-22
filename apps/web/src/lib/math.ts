/**
 * v0.8 F1: rendering TeX with KaTeX. The render API for the editor, page
 * previews, board stickies and (later) G1's HTML export.
 *
 * - KaTeX, its CSS and its fonts live in their own chunk (`katex-chunk.ts`),
 *   loaded on the first math that needs rendering; fonts are bundled assets
 *   served by the app, never fetched from the network.
 * - `trust: false`, `throwOnError: false`, capped size and macro expansion:
 *   vault text can't run anything or hang the page.
 * - Errors never throw: the source is shown in the error colour, with
 *   KaTeX's message as its tooltip.
 */

import { t } from "../i18n/index.js";

export interface MathOptions {
  /** Display (block) math, centred on its own line. */
  display?: boolean;
}

/** What the lazy chunk exports. */
export interface KatexChunk {
  renderToString(tex: string, display: boolean): { html: string; error: string | null };
}

let chunk: Promise<KatexChunk> | null = null;

/** Load KaTeX once (shared by every caller). */
export function loadKatex(): Promise<KatexChunk> {
  chunk ??= import("./katex-chunk.js").then((module) => module.katexChunk);
  return chunk;
}

/** The HTML for `tex` (KaTeX's markup, or an escaped error span); never throws. */
export async function mathToHtml(tex: string, options: MathOptions = {}): Promise<string> {
  const katex = await loadKatex();
  const { html, error } = katex.renderToString(tex, options.display === true);
  if (error === null) return html;
  return `<span class="math-error" title="${escapeHtml(`${t("math.error")}: ${error}`)}">${escapeHtml(tex)}</span>`;
}

/**
 * Render `tex` into `element`: its source right away (so nothing jumps to
 * empty), then the typeset math once KaTeX is loaded. A later call on the
 * same element wins.
 */
export function renderMath(element: HTMLElement, tex: string, options: MathOptions = {}): Promise<void> {
  const token = String(Number(element.dataset.mathToken ?? "0") + 1);
  element.dataset.mathToken = token;
  element.classList.add(options.display ? "math-block" : "math-inline");
  if (!element.firstChild) element.textContent = tex;
  return mathToHtml(tex, options).then(
    (html) => {
      if (element.dataset.mathToken !== token) return;
      element.innerHTML = html;
      element.classList.toggle("has-math-error", html.startsWith('<span class="math-error"'));
    },
    () => {
      // The chunk failed to load (offline dev server restart…): keep the source.
    },
  );
}

/** Render every `[data-math]` placeholder under `root` (previews, stickies). */
export function hydrateMath(root: ParentNode): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-math]")];
  return Promise.all(
    nodes.map((node) => renderMath(node, node.dataset.math ?? "", { display: node.dataset.mathDisplay === "true" })),
  ).then(() => undefined);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
