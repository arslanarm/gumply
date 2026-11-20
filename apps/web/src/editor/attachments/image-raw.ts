/**
 * Keep an image's exact Markdown while it is unchanged (#2ijnyid6):
 * `![a](<my pic.png>)` came back as `![a](my%20pic.png)` because markdown-it
 * normalises the destination. The source is recorded at parse time
 * (`data-md-raw`, see raw-markdown/markdown-plugin.ts) together with the
 * src/alt/title it parsed to; the serializer writes it back while those are
 * the same.
 */
import type { Node as PMNode } from "@tiptap/pm/model";

const RAW = "data-md-raw";

function key(src: unknown, alt: unknown, title: unknown): string {
  return [String(src ?? ""), String(alt ?? ""), String(title ?? "")].join("\u0000");
}

export const imageRawAttributes = {
  markdownRaw: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(RAW),
    renderHTML: () => ({}),
  },
  markdownRawKey: {
    default: null,
    parseHTML: (element: HTMLElement) =>
      element.hasAttribute(RAW)
        ? key(element.getAttribute("src"), element.getAttribute("alt"), element.getAttribute("title"))
        : null,
    renderHTML: () => ({}),
  },
};

/** The original Markdown for this image node, if it is still unchanged. */
export function unchangedImageMarkdown(node: PMNode): string | null {
  const raw = node.attrs.markdownRaw as string | null;
  if (!raw || node.attrs.markdownRawKey !== key(node.attrs.src, node.attrs.alt, node.attrs.title)) return null;
  return raw;
}
