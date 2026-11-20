/**
 * TipTap inline node for `[[wiki links]]`, with Markdown round-trip.
 * The node view is plain DOM (no React portal) so it never flushes React
 * during editor lifecycle work.
 */
import { resolveWikilink } from "@gumply/core";
import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
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
