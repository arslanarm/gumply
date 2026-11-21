/**
 * Opaque nodes for Markdown the editor doesn't model (#82x82ek7). They hold
 * the exact source and write it back unchanged; the node views only show a
 * read-only preview. Click a raw block (or double-click a raw inline) to edit
 * its source.
 *
 * Previews never render vault HTML: tables/callouts go through a separate
 * markdown-it with `html: false` (which escapes everything and rejects
 * `javascript:` links); HTML is shown as source text.
 */
import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { RAW_BLOCK_ATTR, RAW_INLINE_ATTR, rawMarkdownPlugin } from "./markdown-plugin.js";
import { t } from "../../i18n/index.js";

/** The bits of markdown-it the previews use. */
export interface PreviewRenderer {
  render(source: string): string;
  renderInline(source: string): string;
}

type MarkdownItConstructor = new (options: { html: boolean; linkify: boolean }) => PreviewRenderer;

const previews = new WeakMap<Editor, PreviewRenderer>();

/**
 * A plain markdown-it (`html: false`) built from the editor's own copy:
 * tiptap-markdown bundles its markdown-it, and importing another one would
 * add a second copy to the app bundle.
 */
function previewFor(editor: Editor): PreviewRenderer {
  let renderer = previews.get(editor);
  if (!renderer) {
    const storage = editor.storage as unknown as { markdown?: { parser?: { md?: object } } };
    const Ctor = storage.markdown?.parser?.md?.constructor as MarkdownItConstructor | undefined;
    renderer = Ctor
      ? new Ctor({ html: false, linkify: true })
      : { render: (source) => escapeText(source), renderInline: (source) => escapeText(source) };
    previews.set(editor, renderer);
  }
  return renderer;
}

function escapeText(value: string): string {
  return `<pre>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
}

interface SerializerState {
  text(text: string, escape?: boolean): void;
  write(content?: string): void;
  closeBlock(node: PMNode): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const CALLOUT_HEAD = /^\[!([\w-]+)\][+-]?\s*(.*)$/;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Read-only preview of a raw block's source. */
export function renderRawBlockPreview(
  source: string,
  kind: string,
  preview: PreviewRenderer,
): HTMLElement {
  if (kind === "table") {
    const wrap = el("div", "raw-block-table");
    wrap.innerHTML = preview.render(source);
    return wrap;
  }

  if (kind === "callout") {
    const lines = source.split("\n").map((line) => line.replace(/^\s*>\s?/, ""));
    const head = CALLOUT_HEAD.exec(lines[0] ?? "");
    const type = (head?.[1] ?? "note").toLowerCase();
    const box = el("div", "raw-callout");
    box.dataset.callout = type;
    box.append(el("div", "raw-callout-title", head?.[2]?.trim() || capitalize(type)));
    const body = el("div", "raw-callout-body");
    body.innerHTML = preview.render(lines.slice(1).join("\n"));
    if (body.textContent?.trim()) box.append(body);
    return box;
  }

  if (kind === "footnote") {
    const match = /^\[\^([^\]\s]+)\]:\s*([\s\S]*)$/.exec(source);
    const row = el("div", "raw-footnote");
    row.append(el("sup", "raw-footnote-label", match?.[1] ?? "?"));
    const text = el("span", "raw-footnote-text");
    text.innerHTML = preview.renderInline(match?.[2] ?? source);
    row.append(text);
    return row;
  }

  if (kind === "math") {
    return el("pre", "raw-block-math", source.trim().replace(/^\$\$|\$\$$/g, "").trim());
  }

  const wrap = el("div", "raw-block-source");
  const badge = kind === "html" ? "HTML" : kind === "comment" ? t("raw.comment") : "Markdown";
  wrap.append(el("span", "raw-block-badge", badge));
  wrap.append(el("pre", undefined, source));
  return wrap;
}

function autosize(area: HTMLTextAreaElement) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + 2}px`;
}

function rawBlockView({
  node,
  editor,
  getPos,
}: {
  node: PMNode;
  editor: Editor;
  getPos: () => number | undefined;
}) {
  const dom = el("div", "raw-block");
  dom.contentEditable = "false";
  dom.dataset.testid = "raw-block";
  let current = node;
  let area: HTMLTextAreaElement | null = null;

  const render = () => {
    area = null;
    dom.dataset.kind = String(current.attrs.kind);
    dom.title = editor.isEditable ? t("raw.clickToEdit") : "";
    dom.replaceChildren(
      renderRawBlockPreview(String(current.attrs.source), String(current.attrs.kind), previewFor(editor)),
    );
  };

  const finish = (save: boolean) => {
    if (!area) return;
    const value = area.value.replace(/\s+$/, "");
    render();
    const pos = getPos();
    if (!save || typeof pos !== "number" || value === current.attrs.source) {
      editor.commands.focus();
      return;
    }
    const tr = editor.state.tr;
    if (value.trim() === "") tr.delete(pos, pos + current.nodeSize);
    else tr.setNodeMarkup(pos, undefined, { ...current.attrs, source: value });
    editor.view.dispatch(tr);
    editor.commands.focus();
  };

  const edit = () => {
    if (area || !editor.isEditable) return;
    const textarea = el("textarea", "raw-block-editor");
    textarea.value = String(current.attrs.source);
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", t("raw.sourceLabel"));
    textarea.dataset.testid = "raw-block-editor";
    textarea.addEventListener("input", () => autosize(textarea));
    textarea.addEventListener("blur", () => finish(true));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    area = textarea;
    dom.replaceChildren(textarea, el("div", "raw-block-hint", t("raw.editHint")));
    autosize(textarea);
    textarea.focus();
  };

  dom.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a[href]")) return;
    edit();
  });
  render();

  return {
    dom,
    update(next: PMNode) {
      if (next.type !== current.type) return false;
      current = next;
      if (!area) render();
      return true;
    },
    stopEvent: () => area !== null,
    ignoreMutation: () => true,
    selectNode: () => dom.classList.add("is-selected"),
    deselectNode: () => dom.classList.remove("is-selected"),
  };
}

export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute(RAW_BLOCK_ATTR) ?? "",
      },
      kind: {
        default: "raw",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-raw-kind") ?? "raw",
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${RAW_BLOCK_ATTR}]` }];
  },

  renderHTML({ node }) {
    return ["div", { [RAW_BLOCK_ATTR]: node.attrs.source, "data-raw-kind": node.attrs.kind }];
  },

  addNodeView() {
    return (props) => rawBlockView(props as never);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.text(String(node.attrs.source), false);
          state.closeBlock(node);
        },
        parse: {
          setup: rawMarkdownPlugin,
        },
      },
    };
  },
});

/** Read-only preview of a raw inline atom. */
export function renderRawInlinePreview(source: string, kind: string): HTMLElement {
  if (kind === "footnote-ref") return el("sup", "raw-inline-footnote", source.slice(2, -1));
  if (kind === "math") return el("code", "raw-inline-math", source.slice(1, -1));
  // #iatezw4m: a code span wrapped across lines, kept as written.
  if (kind === "code") return el("code", "raw-inline-code", source.replace(/^(`+)\s?([\s\S]*?)\s?\1$/, "$2").replace(/\s*\n\s*/g, " "));
  if (kind === "entity") {
    // Only `&name;` / `&#n;` reach here (see entityRule), so this is safe.
    const decoder = document.createElement("textarea");
    decoder.innerHTML = source;
    return el("span", "raw-inline-entity", decoder.value);
  }
  // `\=`: shows as the `=` it stands for (#bg3cb83t).
  if (kind === "escape") return el("span", "raw-inline-escape", source.slice(1));
  return el("code", "raw-inline-source", source);
}

export const RawInline = Node.create({
  name: "rawInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute(RAW_INLINE_ATTR) ?? "",
      },
      kind: {
        default: "html",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-raw-kind") ?? "html",
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${RAW_INLINE_ATTR}]` }];
  },

  renderHTML({ node }) {
    return ["span", { [RAW_INLINE_ATTR]: node.attrs.source, "data-raw-kind": node.attrs.kind }];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = el("span", "raw-inline");
      dom.contentEditable = "false";
      dom.dataset.testid = "raw-inline";
      dom.title = t("raw.inlineHint", { source: String(node.attrs.source) });
      dom.append(renderRawInlinePreview(String(node.attrs.source), String(node.attrs.kind)));
      // Double-click turns the atom back into plain text to edit; it is
      // recognised again on the next load.
      dom.addEventListener("dblclick", (event) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number" || !editor.isEditable) return;
        const text = editor.schema.text(String(node.attrs.source));
        editor.chain().focus().command(({ tr }) => {
          tr.replaceWith(pos, pos + node.nodeSize, text);
          return true;
        }).setTextSelection(pos + text.nodeSize).run();
      });
      return { dom, ignoreMutation: () => true };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.write(String(node.attrs.source));
        },
        parse: {
          // handled by the RawBlock setup (one plugin for both)
        },
      },
    };
  },
});
