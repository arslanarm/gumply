/**
 * Ordinary Markdown links (`[text](https://…)`).
 *
 * StarterKit has no link mark, so the editor parsed `[docs](https://x)` as
 * plain "docs" and the next autosave wrote the URL away (#jmg9g5t3 hunt).
 *
 * Plain URLs in the text ("visit https://x.com") are linkified on read; they
 * are written back as the bare URL, not as `<https://x.com>`, so files that
 * never had angle brackets don't gain them.
 */
import Link from "@tiptap/extension-link";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { defaultMarkdownSerializer } from "prosemirror-markdown";
import { AUTOLINK_ATTR } from "./raw-markdown/markdown-plugin.js";

interface LinkSerializerState {
  inAutolink?: boolean;
  /** Set while a bare URL is being written (no brackets around it). */
  gumplyBareUrl?: boolean;
  /** The source wrote this URL as `<https://…>`. */
  gumplyAngle?: boolean;
}

const base = defaultMarkdownSerializer.marks.link!;

/** True when the link's text is exactly what linkify turns into this href. */
export function isBareUrl(mark: Mark, parent: PMNode, index: number): boolean {
  if (mark.attrs.title) return false;
  const content = parent.child(index);
  if (!content.isText || !content.text) return false;
  // The whole link must be this single text node.
  const previous = index > 0 ? parent.child(index - 1) : null;
  const next = index < parent.childCount - 1 ? parent.child(index + 1) : null;
  if (previous && mark.isInSet(previous.marks)) return false;
  if (next && mark.isInSet(next.marks)) return false;

  const href = String(mark.attrs.href ?? "");
  const text = content.text;
  if (/\s/.test(text)) return false;
  return (
    (href === text && /^https?:\/\//i.test(text)) ||
    href === `http://${text}` ||
    href === `mailto:${text}`
  );
}

export const markdownLink = {
  open(state: LinkSerializerState, mark: Mark, parent: PMNode, index: number): string {
    if (isBareUrl(mark, parent, index)) {
      // prosemirror-markdown doesn't escape text while inAutolink is set.
      state.inAutolink = true;
      state.gumplyBareUrl = true;
      state.gumplyAngle = Boolean(mark.attrs.autolink);
      return state.gumplyAngle ? "<" : "";
    }
    return (base.open as (...args: unknown[]) => string)(state, mark, parent, index);
  },
  close(state: LinkSerializerState, mark: Mark, parent: PMNode, index: number): string {
    // `index` here points past the link, so use the flag set by `open`.
    if (state.gumplyBareUrl) {
      state.gumplyBareUrl = false;
      state.inAutolink = undefined;
      const angle = state.gumplyAngle;
      state.gumplyAngle = false;
      return angle ? ">" : "";
    }
    return (base.close as (...args: unknown[]) => string)(state, mark, parent, index);
  },
};

export const MarkdownLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // `[text](url "title")` keeps its title on save.
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("title"),
      },
      autolink: {
        default: null,
        parseHTML: (element: HTMLElement) => (element.getAttribute(AUTOLINK_ATTR) ? "angle" : null),
        renderHTML: () => ({}),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize: markdownLink,
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
}).configure({
  // Like Notion: a click opens the link (in a new tab); select to edit text.
  openOnClick: true,
  autolink: true,
  linkOnPaste: true,
  HTMLAttributes: {
    target: "_blank",
    rel: "noopener noreferrer nofollow",
  },
});
