import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The editor parses Markdown with tiptap-markdown, which ships its own
 * markdown-it 14. prosemirror-markdown (via @tiptap/pm) imports the top-level
 * markdown-it 15 only for a default parser Gumply never uses, so both copies
 * (with two `entities` and two `linkify-it`) ended up in the bundle (#evh35bn7).
 * Every `import "markdown-it"` resolves to tiptap-markdown's copy instead: the
 * one the editor already runs on. Tests use it too, so they check the parser
 * the app actually ships.
 */
const fromWeb = createRequire(fileURLToPath(new URL("./package.json", import.meta.url)));
const fromTiptapMarkdown = createRequire(fromWeb.resolve("tiptap-markdown"));

export const markdownItDir = dirname(fromTiptapMarkdown.resolve("markdown-it/package.json"));

/** Vite/Vitest alias entry for the bare `markdown-it` specifier. */
export const markdownItAlias = { find: /^markdown-it$/, replacement: markdownItDir };
