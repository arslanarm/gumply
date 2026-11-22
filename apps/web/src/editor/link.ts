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
import { resolveAttachmentHref } from "@gumply/core";
import Link from "@tiptap/extension-link";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { fileUrl } from "../api/client.js";
import { getWikiLinkEnvironment, type WikiLinkEnvironment } from "./wikilink/link-store.js";
import { defaultMarkdownSerializer } from "prosemirror-markdown";
import { AUTOLINK_ATTR, LINK_SOURCE_ATTR } from "./raw-markdown/markdown-plugin.js";
import { isAllowedLinkUri } from "./link-uri.js";

export { isAllowedLinkUri };

interface LinkSerializerState {
  inAutolink?: boolean;
  /** Set while a bare URL is being written (no brackets around it). */
  gumplyBareUrl?: boolean;
  /** The source wrote this URL as `<https://…>`. */
  gumplyAngle?: boolean;
  out: string;
}

/** How a link was written (#he3ed9uz): see recordLinkSource in raw-markdown. */
interface LinkSource {
  href: string;
  title: string | null;
  /** The label as written between the brackets. */
  label: string;
  /** Everything after the label: `(dest "title")`, `[ref]`, `[]` or "". */
  tail: string;
}

function linkSource(mark: Mark): LinkSource | null {
  const raw = mark.attrs.markdownSource as string | null | undefined;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LinkSource;
    return typeof value.tail === "string" && typeof value.href === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Marks where a recorded link's label starts in `state.out` until its close. */
const LABEL_START = "\u0000gumply-link\u0000";

/**
 * True when the tail as written still says what the mark says: same href and
 * title, and (for `[label]` / `[label][]`, where the label is the reference
 * name) the same label bytes.
 */
function tailStillFits(source: LinkSource, mark: Mark, label: string): boolean {
  if (String(mark.attrs.href ?? "") !== source.href) return false;
  if ((mark.attrs.title ?? null) !== source.title) return false;
  if (source.tail === "" || source.tail === "[]") return label === source.label;
  return true;
}

/** True for a link into the vault (no scheme, not `//host`). */
export function isVaultHref(href: string): boolean {
  const value = href.trim().replace(/^<|>$/g, "");
  return value.length > 0 && !/^(?:[a-z][a-z0-9+.\-]*:|[\\/]{2})/i.test(value) && !value.startsWith("#");
}

/**
 * Where a click on a vault link goes (#he3ed9uz): a note (`Folder/Page.md`,
 * relative to the open note first, then to the vault root) opens in the app;
 * anything else opens as a vault file. Null: not a vault link.
 */
export function vaultLinkTarget(
  href: string,
  env: Pick<WikiLinkEnvironment, "pageId" | "pages">,
): { page: string; heading: string } | { file: string } | null {
  if (!isVaultHref(href)) return null;
  const ids = new Set(env.pages.map((page) => page.id));
  // `Page.md`, or an extensionless `Page` naming a note.
  const isPage = (path: string) =>
    ids.has(path.replace(/\.md$/i, "")) && (/\.md$/i.test(path) || !/\.[^/.]+$/.test(path));
  const path = resolveAttachmentHref(env.pageId, href, isPage);
  if (path === null) return null;
  if (isPage(path)) {
    const hash = href.indexOf("#");
    let heading = hash === -1 ? "" : href.slice(hash + 1);
    try {
      heading = decodeURIComponent(heading);
    } catch {
      // keep as written
    }
    return { page: path.replace(/\.md$/i, ""), heading };
  }
  return { file: path };
}

/** Opens vault links in the app; runs before TipTap's own click handler. */
const vaultLinkClicks = new Plugin({
  key: new PluginKey("gumplyVaultLinkClicks"),
  props: {
    handleClick(_view, _pos, event) {
      if (event.button !== 0) return false;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
      // Only the link mark's own <a>; node views (file cards, embeds) have their own.
      if (!anchor || !anchor.closest(".ProseMirror") || anchor.closest("[data-node-view-wrapper], .react-renderer")) return false;
      const env = getWikiLinkEnvironment();
      const target = vaultLinkTarget(anchor.getAttribute("href") ?? "", env);
      if (!target) return false;
      event.preventDefault();
      if ("page" in target) env.openLink({ targetTitle: target.page, heading: target.heading });
      else window.open(fileUrl(target.file), "_blank", "noopener,noreferrer");
      return true;
    },
  },
});

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
    // #he3ed9uz: a parsed link keeps its tail as written; see `close`.
    if (linkSource(mark)) return `[${LABEL_START}`;
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
    const source = linkSource(mark);
    if (source) {
      const at = state.out.lastIndexOf(LABEL_START);
      let label = "";
      if (at !== -1) {
        label = state.out.slice(at + LABEL_START.length);
        state.out = state.out.slice(0, at) + label;
      }
      if (tailStillFits(source, mark, label)) return `]${source.tail}`;
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
      // #he3ed9uz: how the link was written (never rendered, so not copied).
      markdownSource: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(LINK_SOURCE_ATTR),
        renderHTML: () => ({}),
      },
    };
  },

  addProseMirrorPlugins() {
    return [vaultLinkClicks, ...(this.parent?.() ?? [])];
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
  isAllowedUri: (url, ctx) => isAllowedLinkUri(url, ctx.defaultValidate),
  autolink: true,
  linkOnPaste: true,
  HTMLAttributes: {
    target: "_blank",
    rel: "noopener noreferrer nofollow",
  },
});
