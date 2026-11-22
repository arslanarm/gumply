/**
 * v0.8 F1: the only module that imports KaTeX. `lib/math.ts` loads it with a
 * dynamic `import()`, so KaTeX, its CSS and its fonts stay out of the main
 * bundle and load with the first math on screen.
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import type { KatexChunk } from "./math.js";

export const katexChunk: KatexChunk = {
  renderToString(tex, display, output = "html") {
    try {
      const html = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        // Never: \href, \url, \includegraphics, \htmlClass… from vault text.
        trust: false,
        strict: "ignore",
        output: output === "mathml" ? "mathml" : "htmlAndMathml",
        // Bounds for hostile input: no giant boxes, no runaway macros.
        maxSize: 50,
        maxExpand: 500,
      });
      return { html, error: null };
    } catch (error) {
      return { html: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};
