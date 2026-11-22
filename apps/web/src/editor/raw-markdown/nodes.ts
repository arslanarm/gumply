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
import { renderMath } from "../../lib/math.js";

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
    // F1: typeset with KaTeX (lazy); the source shows until it has loaded.
    const box = el("div", "raw-block-math");
    const tex = source.trim().replace(/^\$\$|\$\$$/g, "").trim();
    if (!tex) {
      box.classList.add("is-empty");
      box.textContent = t("math.empty");
      return box;
    }
    void renderMath(box, tex, { display: true });
    return box;
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
  if (kind === "math") {
    const span = el("span", "raw-inline-math");
    void renderMath(span, source.slice(1, -1));
    return span;
  }
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
  // A tab inside text (#ftx3awn7): shown at a tab's width.
  if (kind === "tab") return el("span", "raw-inline-tab", "\t");
  return el("code", "raw-inline-source", source);
}

/**
 * F1: a small source field inside an inline math atom. A value that is still
 * `$…$` stays an atom; anything else becomes plain text (recognised again on
 * the next load, like the double-click edit).
 */
function editInlineMath(dom: HTMLElement, node: PMNode, editor: Editor, getPos: () => number | undefined): void {
  const source = String(node.attrs.source);
  const input = el("input", "raw-inline-math-editor");
  input.value = source;
  input.spellcheck = false;
  input.setAttribute("aria-label", t("math.sourceLabel"));
  input.dataset.testid = "math-inline-editor";
  input.size = Math.max(4, source.length + 1);
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const value = input.value;
    const pos = getPos();
    if (!save || value === source || typeof pos !== "number") {
      dom.replaceChildren(renderRawInlinePreview(source, "math"));
      editor.commands.focus();
      return;
    }
    const tr = editor.state.tr;
    if (value === "") tr.delete(pos, pos + node.nodeSize);
    else if (/^\$[^$\n]+\$$/.test(value)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: value });
    else tr.replaceWith(pos, pos + node.nodeSize, editor.schema.text(value));
    editor.view.dispatch(tr);
    editor.commands.focus();
  };
  input.addEventListener("input", () => (input.size = Math.max(4, input.value.length + 1)));
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
  });
  dom.replaceChildren(input);
  input.focus();
  input.setSelectionRange(1, Math.max(1, source.length - 1));
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
      // F1: inline math edits as source on click; Enter or leaving saves, Esc
      // goes back to the rendered math unchanged.
      if (node.attrs.kind === "math") {
        dom.title = t("math.inlineHint");
        dom.addEventListener("click", (event) => {
          if (!editor.isEditable || dom.querySelector("input")) return;
          event.preventDefault();
          editInlineMath(dom, node, editor, typeof getPos === "function" ? getPos : () => undefined);
        });
      }
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
      return { dom, ignoreMutation: () => true, stopEvent: (event: Event) => event.target instanceof HTMLInputElement };
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
