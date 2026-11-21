/**
 * Keep a page's own bullet marker and nested-list indent (#82x82ek7).
 *
 * Obsidian writes nested lists with a tab or 4 spaces and some people use
 * `*` bullets; the editor always wrote `-` with 2 spaces, so the first edit
 * re-indented every nested list in an imported note. The style is detected
 * from the page's Markdown when it opens and used when it is written back.
 */
import BulletList from "@tiptap/extension-bullet-list";
import TaskList from "@tiptap/extension-task-list";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface ListStyle {
  marker: "-" | "*" | "+";
  indent: string;
}

export const DEFAULT_LIST_STYLE: ListStyle = { marker: "-", indent: "  " };

const BULLET_LINE = /^([ \t]*)([-*+])(?:[ \t]+|$)/;

/** Bullet marker and nesting indent used in `markdown` (defaults otherwise). */
export function detectListStyle(markdown: string): ListStyle {
  const style: ListStyle = { ...DEFAULT_LIST_STYLE };
  const lines = markdown.split("\n");
  let inFence = false;
  let markerFound = false;
  let previousTopBullet = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = BULLET_LINE.exec(line);
    // A thematic break (`---`, `* * *`) is not a bullet.
    if (!match || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      if (line.trim().length > 0 && !/^\s/.test(line)) previousTopBullet = false;
      continue;
    }
    const [, lead = "", marker] = match;
    if (!markerFound) {
      style.marker = marker as ListStyle["marker"];
      markerFound = true;
    }
    if (lead.length === 0) {
      previousTopBullet = true;
      continue;
    }
    // First bullet nested directly under a top-level bullet sets the indent.
    if (previousTopBullet) {
      style.indent = lead.startsWith("\t") ? "\t" : lead.length >= 2 && lead.length <= 4 ? lead : style.indent;
      break;
    }
  }
  return style;
}

interface ListSerializerState {
  flushClose(size?: number): void;
  closed?: unknown;
  renderList(node: PMNode, delim: string, firstDelim: (index: number) => string): void;
}

function styleOf(editor: Editor): ListStyle {
  const storage = editor.storage as unknown as { markdownListStyle?: { style?: ListStyle } };
  return storage.markdownListStyle?.style ?? DEFAULT_LIST_STYLE;
}

const HALVES = new Set(["bulletList", "taskList"]);

/**
 * prosemirror-markdown puts two blank lines between adjacent lists of the
 * same type (an old CommonMark idiom). Adjacent lists here always differ in
 * marker, so the usual single blank line keeps them apart.
 *
 * A bullet list next to a task list is one Markdown list split in two (plain
 * and to-do items): when both use the same bullet, are tight, and no blank
 * line separated them in the source, they are written as one tight list
 * (#fmmght8w). Different bullets are two Markdown lists: the blank line
 * between them stays.
 */
export function separateFromPreviousList(state: ListSerializerState, node: PMNode, sameMarker = false): void {
  const closed = state.closed as PMNode | null | undefined;
  if (!closed) return;
  if (closed.type === node.type) state.flushClose(2);
  else if (
    sameMarker &&
    HALVES.has(closed.type.name) &&
    HALVES.has(node.type.name) &&
    closed.attrs.tight !== false &&
    node.attrs.tight !== false &&
    !node.attrs.markdownLooseJoin
  ) {
    state.flushClose(1);
  }
}

const MARKERS = new Set(["-", "*", "+"]);

/** The list's own marker (as read), else the page's; never the same as an
 * adjacent list of the same kind, which would merge the two on reload. */
function bulletMarker(editor: Editor, node: PMNode, parent?: PMNode, index = 0): string {
  const own = node.attrs.markdownMarkup as string | null;
  if (own && MARKERS.has(own)) return own;
  const pageMarker = styleOf(editor).marker;
  const previous = parent && index > 0 ? parent.child(index - 1) : null;
  if (previous?.type === node.type) {
    const before = bulletMarker(editor, previous, parent, index - 1);
    if (before === pageMarker) return pageMarker === "-" ? "*" : "-";
  }
  return pageMarker;
}

function serializeBullets(
  this: { editor: Editor },
  state: ListSerializerState,
  node: PMNode,
  parent?: PMNode,
  index?: number,
) {
  const marker = bulletMarker(this.editor, node, parent, index);
  const previous = parent && index ? parent.child(index - 1) : null;
  const sameMarker =
    !!previous && HALVES.has(previous.type.name) && bulletMarker(this.editor, previous, parent, index! - 1) === marker;
  separateFromPreviousList(state, node, sameMarker);
  state.renderList(node, styleOf(this.editor).indent, () => `${marker} `);
}

// No `parse` key below: tiptap-markdown merges this spec over its default
// one per top-level key, so the task list's built-in parse setup stays.
export const MarkdownBulletList = BulletList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeBullets,
      },
    };
  },
});

export const MarkdownTaskList = TaskList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeBullets,
      },
    };
  },
});

/** Remember `markdown`'s list style on the editor. */
export function setListStyle(editor: Editor, markdown: string): void {
  const storage = editor.storage as unknown as Record<string, { style?: ListStyle }>;
  storage.markdownListStyle = { style: detectListStyle(markdown) };
}
