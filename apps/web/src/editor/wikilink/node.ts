/**
 * TipTap inline node for `[[wiki links]]`, with Markdown round-trip.
 * The node view is plain DOM (no React portal) so it never flushes React
 * during editor lifecycle work.
 */
import { hasAttachmentExtension, linkTargetFor, resolveWikilink } from "@gumply/core";
import { InputRule, Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { parseWikiLinkText } from "../../lib/wikilinks.js";
import {
  getWikiLinkEnvironment,
  subscribeWikiLinkEnvironment,
} from "./link-store.js";
import { wikilinkMarkdownPlugin } from "./markdown-plugin.js";

export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      targetTitle: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-wikilink-title") ?? element.textContent ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-wikilink-title": attributes.targetTitle,
        }),
      },
      alias: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-wikilink-alias") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-wikilink-alias": attributes.alias,
        }),
      },
      heading: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-wikilink-heading") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-wikilink-heading": attributes.heading,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "wiki-link" }];
  },

  addInputRules() {
    return [
      new InputRule({
        // Completing a typed link with `]]` renders it immediately instead of
        // leaving raw text (and the `[[` suggestion decoration) until reload
        // (walkthrough #2, #c62p7zfp). Input rules already skip code blocks
        // and code marks, so `[[X]]` in code stays literal.
        find: /\[\[([^[\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const parsed = parseWikiLinkText(match[0] ?? "");
          if (!parsed) return null;

          // `[[file.pdf]]` is an attachment (D19), not a page link.
          if (hasAttachmentExtension(parsed.title)) {
            const fileType = state.schema.nodes.fileAttachment;
            if (!fileType) return null;
            const path = parsed.title.includes("/")
              ? parsed.title
              : `attachments/${parsed.title}`;
            state.tr.replaceWith(
              range.from,
              range.to,
              fileType.create({
                path,
                name: parsed.title.split("/").pop() ?? parsed.title,
                size: 0,
              }),
            );
            return;
          }

          const type = state.schema.nodes.wikiLink;
          if (!type) return null;

          // While a code span is being typed (`` `[[X]]` ``) the code mark does
          // not exist yet; an unmatched backtick to the left means the link is
          // code, not a link. Code blocks/marks are already skipped upstream.
          const $from = state.doc.resolve(range.from);
          const before = $from.parent.textBetween(0, $from.parentOffset);
          if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return null;

          // A typed `[[Ideas: Q3?]]` for a page saved as `Ideas Q3.md` is
          // written `[[Ideas Q3|Ideas: Q3?]]`, so Obsidian resolves it too
          // (#mp8eadhk). Unknown titles and plain matches stay as typed.
          const { pages } = getWikiLinkEnvironment();
          const page = resolveWikilink(parsed.title, pages);
          const link =
            page && page.title.trim().toLowerCase() === parsed.title.trim().toLowerCase()
              ? linkTargetFor(page, pages)
              : { target: parsed.title, alias: "" };

          state.tr.replaceWith(
            range.from,
            range.to,
            type.create({
              targetTitle: link.target,
              alias: parsed.alias || link.alias,
              heading: parsed.heading,
            }),
          );
        },
      }),
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "wiki-link",
      mergeAttributes(HTMLAttributes, { "data-type": "wiki-link" }),
      node.attrs.alias || node.attrs.targetTitle,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "wiki-link";
      dom.setAttribute("contenteditable", "false");

      const label = document.createElement("span");
      label.className = "wiki-link-label";
      label.setAttribute("role", "link");
      label.tabIndex = 0;

      const headingEl = document.createElement("span");
      headingEl.className = "wiki-link-heading";

      dom.append(label, headingEl);

      let current: ProseMirrorNode = node;

      const attrs = () => ({
        targetTitle: String(current.attrs.targetTitle ?? ""),
        alias: String(current.attrs.alias ?? ""),
        heading: String(current.attrs.heading ?? ""),
      });

      const render = () => {
        const { targetTitle, alias, heading } = attrs();
        const resolved = resolveWikilink(targetTitle, getWikiLinkEnvironment().pages);

        dom.classList.toggle("is-resolved", resolved !== null);
        dom.classList.toggle("is-unresolved", resolved === null);
        dom.classList.toggle("is-alias", alias.length > 0);
        dom.setAttribute("data-testid", `wiki-link-${resolved ? resolved.id : targetTitle}`);
        dom.setAttribute("data-resolved", resolved ? "true" : "false");
        dom.title = resolved
          ? alias.length > 0
            ? `Links to “${resolved.title}”`
            : resolved.title
          : "Page doesn't exist — click to create";

        label.textContent = alias.length > 0 ? alias : targetTitle;
        headingEl.textContent = heading.length > 0 ? `#${heading}` : "";
        headingEl.style.display = heading.length > 0 ? "" : "none";
      };

      const activate = (event?: Event) => {
        event?.preventDefault();
        const { targetTitle, heading } = attrs();
        getWikiLinkEnvironment().openLink({ targetTitle, heading });
      };

      label.addEventListener("click", (event) => {
        event.stopPropagation();
        activate(event);
      });
      label.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(event);
        }
      });

      render();
      const unsubscribe = subscribeWikiLinkEnvironment(render);

      return {
        dom,
        update(updated: ProseMirrorNode) {
          if (updated.type.name !== "wikiLink") return false;
          current = updated;
          render();
          return true;
        },
        destroy() {
          unsubscribe();
        },
      };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const title = String(node.attrs.targetTitle ?? "");
          const alias = String(node.attrs.alias ?? "");
          const heading = String(node.attrs.heading ?? "");
          let inner = title;
          if (heading.length > 0) inner += `#${heading}`;
          if (alias.length > 0) inner += `|${alias}`;
          state.write(`[[${inner}]]`);
        },
        parse: {
          setup(md: any) {
            wikilinkMarkdownPlugin(md);
          },
        },
      },
    };
  },
});
