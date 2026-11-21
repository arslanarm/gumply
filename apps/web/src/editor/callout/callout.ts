/**
 * Editable callouts and toggles (D29, #uigzc42i).
 *
 * A callout is an icon, a title and a body of any blocks. A toggle is a
 * foldable callout (`[!type]-` closed by default, `[!type]+` open). Opening
 * or closing a toggle is view state (a node decoration), never written to the
 * file; only "Start closed / Start open" in the block menu changes the marker.
 */
import { createDocument, InputRule, Node, wrappingInputRule, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode, type ResolvedPos, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  CALLOUT_ATTR,
  CALLOUT_SOURCE_ATTR,
  CALLOUT_TITLE_ATTR,
  isEmptyBody,
  retargetSource,
  serializeCallout,
  type CalloutSerializerState,
} from "./markdown.js";
import {
  CALLOUT_TYPES,
  CHEVRON_ICON,
  calloutIcon,
  calloutStyle,
  defaultCalloutTitle,
  svgIcon,
  type CalloutFold,
} from "./types.js";
import { t } from "../../i18n/index.js";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Turn the current text block into a callout (or toggle). */
      setCallout: (options?: { type?: string; fold?: CalloutFold; textInto?: "title" | "body" }) => ReturnType;
    };
  }
}

// ---------- fold (view state) ----------

export const calloutFoldKey = new PluginKey<DecorationSet>("calloutFold");

interface FoldChange {
  pos: number;
  /** null: back to the default from the fold marker. */
  open: boolean | null;
}

function foldOverride(decorations: readonly Decoration[]): boolean | undefined {
  for (const decoration of decorations) {
    const open = (decoration.spec as { calloutOpen?: boolean }).calloutOpen;
    if (open !== undefined) return open;
  }
  return undefined;
}

export function isFoldable(node: PMNode): boolean {
  return node.attrs.fold === "+" || node.attrs.fold === "-";
}

/** Whether the callout at `pos` is shown open right now. */
export function isCalloutOpen(state: EditorState, pos: number, node: PMNode): boolean {
  if (!isFoldable(node)) return true;
  const set = calloutFoldKey.getState(state);
  const override = set ? foldOverride(set.find(pos, pos + 1).filter((d) => d.from === pos)) : undefined;
  return override ?? node.attrs.fold !== "-";
}

function setFold(tr: Transaction, change: FoldChange): Transaction {
  const changes = (tr.getMeta(calloutFoldKey) as FoldChange[] | undefined) ?? [];
  return tr.setMeta(calloutFoldKey, [...changes, change]);
}

const calloutFoldPlugin = new Plugin<DecorationSet>({
  key: calloutFoldKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc);
      const changes = tr.getMeta(calloutFoldKey) as FoldChange[] | undefined;
      for (const change of changes ?? []) {
        next = next.remove(next.find(change.pos, change.pos + 1).filter((d) => d.from === change.pos));
        const node = tr.doc.nodeAt(change.pos);
        if (change.open === null || !node || node.type.name !== "callout") continue;
        if (change.open === (node.attrs.fold !== "-")) continue;
        next = next.add(tr.doc, [
          Decoration.node(change.pos, change.pos + node.nodeSize, {}, { calloutOpen: change.open }),
        ]);
      }
      return next;
    },
  },
  props: {
    decorations(state) {
      const set = calloutFoldKey.getState(state) ?? DecorationSet.empty;
      // Mark callouts holding the caret: a title-only callout shows its
      // empty body line only while you're editing it.
      const { $from } = state.selection;
      const marks: Decoration[] = [];
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name !== "callout") continue;
        const pos = $from.before(depth);
        marks.push(Decoration.node(pos, pos + $from.node(depth).nodeSize, { class: "has-caret" }));
      }
      return marks.length ? set.add(state.doc, marks) : set;
    },
  },
});

// ---------- document helpers ----------

/** Depth of the innermost callout around `$pos` (optionally foldable only), or -1. */
function calloutDepth($pos: ResolvedPos, foldableOnly = false): number {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "callout" && (!foldableOnly || isFoldable(node))) return depth;
  }
  return -1;
}

/** Open or close the toggle around the selection (Cmd/Ctrl+Enter). */
export function toggleCalloutAtSelection(editor: Editor): boolean {
  const { state } = editor;
  const depth = calloutDepth(state.selection.$from, true);
  if (depth < 0) return false;
  const pos = state.selection.$from.before(depth);
  return toggleCalloutAt(editor.view, pos);
}

/** Open or close the toggle at `pos`; closing moves a caret out of the hidden body. */
export function toggleCalloutAt(view: EditorView, pos: number): boolean {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "callout" || !isFoldable(node)) return false;
  const open = !isCalloutOpen(state, pos, node);
  const tr = setFold(state.tr, { pos, open });
  const titleEnd = pos + 1 + (node.firstChild?.nodeSize ?? 2) - 1;
  const { from, to } = state.selection;
  if (!open && to > titleEnd + 1 && from < pos + node.nodeSize) {
    tr.setSelection(TextSelection.create(tr.doc, titleEnd));
  }
  view.dispatch(tr);
  return true;
}

/** Change a callout's type; an unchanged body keeps its exact source. */
export function setCalloutType(view: EditorView, pos: number, type: string): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "callout" || node.attrs.type === type) return;
  const source = retargetSource(node.attrs.source as string | null, type, node.attrs.fold as CalloutFold);
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, type, source }));
}

/** Change the fold marker on disk ("Start closed" / "Start open" / not a toggle). */
export function setCalloutFold(view: EditorView, pos: number, fold: CalloutFold): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "callout" || node.attrs.fold === fold) return;
  const source = retargetSource(node.attrs.source as string | null, String(node.attrs.type), fold);
  const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, fold, source });
  view.dispatch(setFold(tr, { pos, open: null }));
}

function paragraph(state: EditorState, content?: Fragment): PMNode {
  return state.schema.nodes.paragraph!.create(null, content);
}

/** Enter in a title: into the body (or after a closed toggle). */
function enterInTitle(editor: Editor): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  if ($from.parent.type.name !== "calloutTitle") return false;
  const depth = $from.depth - 1;
  const calloutPos = $from.before(depth);
  const callout = $from.node(depth);
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  const $pos = tr.selection.$from;

  if (!isCalloutOpen(state, calloutPos, callout)) {
    const after = calloutPos + tr.doc.nodeAt(calloutPos)!.nodeSize;
    tr.insert(after, paragraph(state));
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  } else {
    const titleEnd = $pos.end();
    const moved = tr.doc.slice($pos.pos, titleEnd).content;
    tr.delete($pos.pos, titleEnd);
    const bodyStart = tr.doc.resolve($pos.pos).after();
    const first = tr.doc.nodeAt(bodyStart);
    if (!(moved.size === 0 && first?.type.name === "paragraph" && first.content.size === 0)) {
      tr.insert(bodyStart, paragraph(state, moved));
    }
    tr.setSelection(TextSelection.create(tr.doc, bodyStart + 1));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Enter in an empty last body paragraph: continue after the callout. */
function exitFromBody(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) return false;
  const depth = $from.depth - 1;
  if (depth < 1) return false;
  const callout = $from.node(depth);
  const index = $from.index(depth);
  if (callout.type.name !== "callout" || index < 1 || index !== callout.childCount - 1) return false;
  const calloutPos = $from.before(depth);
  const tr = state.tr;
  if (callout.childCount > 2) tr.delete($from.before(), $from.after());
  const after = calloutPos + tr.doc.nodeAt(calloutPos)!.nodeSize;
  tr.insert(after, paragraph(state));
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Backspace at the start of a title: back to a paragraph, body blocks kept below. */
function unwrapFromTitle(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "calloutTitle" || $from.parentOffset > 0) return false;
  const depth = $from.depth - 1;
  const callout = $from.node(depth);
  const pos = $from.before(depth);
  const blocks: PMNode[] = [paragraph(state, $from.parent.content)];
  if (!isEmptyBody(callout)) callout.forEach((child, _offset, index) => index > 0 && blocks.push(child));
  const parent = $from.node(depth - 1);
  const at = $from.index(depth - 1);
  if (!parent.canReplace(at, at + 1, Fragment.from(blocks))) return false;
  const tr = state.tr.replaceWith(pos, pos + callout.nodeSize, blocks);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Backspace at the start of the first body paragraph: join it to the title. */
function backspaceIntoTitle(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset > 0 || $from.parent.type.name !== "paragraph") return false;
  const depth = $from.depth - 1;
  if (depth < 1) return false;
  const callout = $from.node(depth);
  if (callout.type.name !== "callout" || $from.index(depth) !== 1) return false;
  const title = callout.firstChild!;
  const titleEnd = $from.before(depth) + 1 + title.nodeSize - 1;
  const content = $from.parent.content;
  const tr = state.tr;
  if (callout.childCount > 2) tr.delete($from.before(), $from.after());
  else if (content.size > 0) tr.replaceWith($from.before(), $from.after(), paragraph(state));
  if (content.size > 0) tr.insert(titleEnd, content);
  tr.setSelection(TextSelection.create(tr.doc, titleEnd));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------- byte-for-byte ----------

/**
 * Parsed callout sources, per schema: every editor (a page switch, a reload
 * after an outside change) builds its own schema, and nodes of another
 * schema never compare equal.
 */
const parsedSources = new WeakMap<Schema, Map<string, PMNode | null>>();

/** The callout's original source when it is unchanged since it was read. */
function keptSource(editor: Editor | undefined, node: PMNode): string | null {
  const source = node.attrs.source as string | null;
  if (!source || !editor) return null;
  let cache = parsedSources.get(node.type.schema);
  if (!cache) {
    cache = new Map();
    parsedSources.set(node.type.schema, cache);
  }
  let parsed = cache.get(source);
  if (parsed === undefined) {
    parsed = null;
    try {
      const storage = editor.storage as unknown as { markdown?: { parser?: { parse(content: string): string } } };
      const html = storage.markdown?.parser?.parse(source);
      if (html !== undefined) {
        const doc = createDocument(html, editor.schema, editor.options.parseOptions);
        if (doc.childCount === 1 && doc.firstChild?.type.name === "callout") parsed = doc.firstChild;
      }
    } catch {
      parsed = null;
    }
    if (cache.size > 500) cache.clear();
    cache.set(source, parsed);
  }
  return parsed && parsed.eq(node) ? source : null;
}

// ---------- node view ----------

function button(className: string, testid: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.contentEditable = "false";
  element.tabIndex = -1;
  element.dataset.testid = testid;
  return element;
}

function calloutView({
  node,
  getPos,
  decorations,
  editor,
}: {
  node: PMNode;
  getPos: () => number | undefined;
  decorations: readonly Decoration[];
  editor: Editor;
}) {
  const view = editor.view;
  let current = node;
  let open = true;
  const dom = document.createElement("div");
  dom.className = "callout";
  dom.dataset.testid = "callout";
  const icon = button("callout-icon", "callout-icon");
  icon.title = t("callout.changeType");
  icon.setAttribute("aria-haspopup", "listbox");
  const fold = button("callout-fold", "callout-fold");
  fold.append(svgIcon(CHEVRON_ICON, 16));
  const content = document.createElement("div");
  content.className = "callout-content";
  dom.append(icon, content, fold);
  let picker: HTMLElement | null = null;

  const position = () => {
    const pos = getPos();
    return typeof pos === "number" ? pos : null;
  };

  const apply = (decos: readonly Decoration[]) => {
    const type = String(current.attrs.type || "note");
    const foldable = isFoldable(current);
    open = !foldable || (foldOverride(decos) ?? current.attrs.fold !== "-");
    dom.dataset.callout = type;
    dom.dataset.calloutStyle = calloutStyle(type);
    dom.dataset.fold = String(current.attrs.fold ?? "");
    dom.classList.toggle("is-foldable", foldable);
    dom.classList.toggle("is-closed", !open);
    const title = current.firstChild;
    dom.classList.toggle("is-title-empty", !title || title.content.size === 0);
    dom.classList.toggle("is-body-empty", isEmptyBody(current));
    dom.style.setProperty("--callout-placeholder", JSON.stringify(defaultCalloutTitle(type)));
    icon.replaceChildren(calloutIcon(type));
    icon.setAttribute("aria-label", t("callout.typeLabel", { type: defaultCalloutTitle(type) }));
    icon.setAttribute("aria-expanded", picker ? "true" : "false");
    fold.hidden = !foldable;
    fold.setAttribute("aria-label", open ? t("callout.closeToggle") : t("callout.openToggle"));
    fold.setAttribute("aria-expanded", String(open));
    const keys = `${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter`;
    fold.title = open ? t("callout.closeHint", { keys }) : t("callout.openHint", { keys });
  };

  const closePicker = (refocus: boolean) => {
    if (!picker) return;
    picker.remove();
    picker = null;
    document.removeEventListener("mousedown", onOutside, true);
    icon.setAttribute("aria-expanded", "false");
    if (refocus) view.focus();
  };

  const onOutside = (event: MouseEvent) => {
    if (picker && !picker.contains(event.target as globalThis.Node) && event.target !== icon && !icon.contains(event.target as globalThis.Node)) {
      closePicker(false);
    }
  };

  const openPicker = () => {
    if (picker || !editor.isEditable) return;
    const type = String(current.attrs.type || "note");
    const list = document.createElement("div");
    list.className = "callout-picker";
    list.contentEditable = "false";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", t("callout.typePicker"));
    list.dataset.testid = "callout-picker";
    const types: string[] = [...CALLOUT_TYPES];
    if (!types.includes(type)) types.push(type);
    for (const option of types) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "callout-picker-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option === type));
      item.dataset.testid = `callout-type-${option}`;
      item.dataset.calloutStyle = calloutStyle(option);
      const glyph = document.createElement("span");
      glyph.className = "callout-picker-icon";
      glyph.append(calloutIcon(option, 16));
      item.append(glyph, document.createTextNode(defaultCalloutTitle(option)));
      item.addEventListener("click", () => {
        const pos = position();
        closePicker(true);
        if (pos !== null) setCalloutType(view, pos, option);
      });
      list.append(item);
    }
    list.addEventListener("keydown", (event) => {
      const items = [...list.querySelectorAll<HTMLButtonElement>(".callout-picker-item")];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    picker = list;
    dom.append(list);
    icon.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside, true);
    (list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? list.querySelector("button"))?.focus();
  };

  icon.addEventListener("mousedown", (event) => event.preventDefault());
  icon.addEventListener("click", () => (picker ? closePicker(true) : openPicker()));
  fold.addEventListener("mousedown", (event) => event.preventDefault());
  fold.addEventListener("click", () => {
    const pos = position();
    if (pos !== null) toggleCalloutAt(view, pos);
  });

  apply(decorations);

  return {
    dom,
    contentDOM: content,
    update(next: PMNode, decos: readonly Decoration[]) {
      if (next.type !== current.type) return false;
      current = next;
      apply(decos);
      return true;
    },
    stopEvent(event: Event) {
      const target = event.target as globalThis.Node | null;
      return !!target && (icon.contains(target) || fold.contains(target) || !!picker?.contains(target));
    },
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
      if (mutation.type === "selection") return false;
      return !content.contains(mutation.target);
    },
    destroy() {
      closePicker(false);
    },
  };
}

// ---------- nodes ----------

export const CalloutTitle = Node.create({
  name: "calloutTitle",
  content: "inline*",
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: `div[${CALLOUT_TITLE_ATTR}]` }];
  },

  renderHTML() {
    return ["div", { [CALLOUT_TITLE_ATTR]: "", class: "callout-title" }, 0];
  },

  addKeyboardShortcuts() {
    return {
      // One line: no hard breaks in a title.
      "Shift-Enter": () => this.editor.state.selection.$from.parent.type.name === "calloutTitle",
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: CalloutSerializerState, node: PMNode) {
          state.renderInline(node);
          state.closeBlock(node);
        },
      },
    };
  },
});

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "calloutTitle block+",
  defining: true,

  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (element: HTMLElement) => element.getAttribute(CALLOUT_ATTR) || "note",
        renderHTML: (attributes: Record<string, unknown>) => ({ [CALLOUT_ATTR]: attributes.type }),
      },
      fold: {
        default: "",
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("data-fold");
          return value === "+" || value === "-" ? value : "";
        },
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-fold": attributes.fold }),
      },
      /** Exact Markdown it was read from (written back while unchanged). */
      source: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(CALLOUT_SOURCE_ATTR),
        // Not copied to the clipboard: a pasted callout is written fresh.
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${CALLOUT_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, class: "callout" }, 0];
  },

  addNodeView() {
    return (props) => calloutView(props as never);
  },

  addProseMirrorPlugins() {
    return [calloutFoldPlugin];
  },

  addCommands() {
    return {
      setCallout:
        (options = {}) =>
        ({ tr, state, dispatch }) => {
          const { $from } = tr.selection;
          const block = $from.parent;
          if (!block.isTextblock || block.type.name === "calloutTitle" || block.type.spec.code) return false;
          const depth = $from.depth;
          const parent = $from.node(depth - 1);
          const index = $from.index(depth - 1);
          const calloutType = state.schema.nodes.callout!;
          if (!parent.canReplaceWith(index, index + 1, calloutType)) return false;
          const into = options.textInto ?? "body";
          const fold = options.fold ?? "";
          const title = state.schema.nodes.calloutTitle!.create(null, into === "title" ? block.content : undefined);
          const body = paragraph(state, into === "body" ? block.content : undefined);
          const callout = calloutType.create({ type: options.type ?? "note", fold }, [title, body]);
          if (!dispatch) return true;
          const pos = $from.before(depth);
          tr.replaceWith(pos, pos + block.nodeSize, callout);
          const caret = into === "title" ? pos + 2 + title.content.size : pos + 1 + title.nodeSize + 1 + body.content.size;
          tr.setSelection(TextSelection.create(tr.doc, caret));
          // A new toggle starts closed on disk but shows open while you fill it.
          if (fold === "-") setFold(tr, { pos, open: true });
          return true;
        },
    };
  },

  addInputRules() {
    return [
      // Notion: `>` + space at the start of a line makes a toggle.
      new InputRule({
        find: /^>\s$/,
        handler: ({ range, commands, can }) => {
          // Where a callout can't go (a list item's first line), `>` stays a quote.
          if (!can().setCallout()) return null;
          commands.deleteRange(range);
          commands.setCallout({ type: "note", fold: "-", textInto: "title" });
        },
      }),
      // Notion: `"` + space makes a quote (`>` now makes a toggle).
      ...(this.editor.schema.nodes.blockquote
        ? [wrappingInputRule({ find: /^"\s$/, type: this.editor.schema.nodes.blockquote })]
        : []),
    ];
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => toggleCalloutAtSelection(this.editor),
      Enter: () => enterInTitle(this.editor) || exitFromBody(this.editor),
      Backspace: () => unwrapFromTitle(this.editor) || backspaceIntoTitle(this.editor),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(this: { editor?: Editor }, state: CalloutSerializerState, node: PMNode) {
          serializeCallout(state, node, (candidate) => keptSource(this.editor, candidate));
        },
      },
    };
  },
});
