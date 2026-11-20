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
  renderList(node: PMNode, delim: string, firstDelim: (index: number) => string): void;
}

function styleOf(editor: Editor): ListStyle {
  const storage = editor.storage as unknown as { markdownListStyle?: { style?: ListStyle } };
  return storage.markdownListStyle?.style ?? DEFAULT_LIST_STYLE;
}

function serializeBullets(this: { editor: Editor }, state: ListSerializerState, node: PMNode) {
  const { marker, indent } = styleOf(this.editor);
  state.renderList(node, indent, () => `${marker} `);
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
