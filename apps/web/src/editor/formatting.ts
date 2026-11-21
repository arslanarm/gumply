/**
 * Text formatting shared by the selection toolbar and the editor's context
 * menu (#bg3cb83t). Everything is standard Markdown on disk (`**`, `*`,
 * `~~`, `` ` ``, `[]()`) plus Obsidian's `==` for highlight.
 */
import { Extension, type Editor } from "@tiptap/core";
import type { IconName } from "../components/Icon.js";
import { currentModifierLabel } from "../lib/shortcuts.js";

export type MarkName = "bold" | "italic" | "strike" | "code" | "highlight";

export interface MarkAction {
  mark: MarkName;
  label: string;
  icon: IconName;
  /** Shortcut as shown in tooltips (⌘ or Ctrl). */
  keys: string;
}

export function markActions(): MarkAction[] {
  const mod = currentModifierLabel();
  return [
    { mark: "bold", label: "Bold", icon: "bold", keys: `${mod}+B` },
    { mark: "italic", label: "Italic", icon: "italic", keys: `${mod}+I` },
    { mark: "strike", label: "Strikethrough", icon: "strike", keys: `${mod}+Shift+S` },
    { mark: "code", label: "Inline code", icon: "code", keys: `${mod}+E` },
    { mark: "highlight", label: "Highlight", icon: "highlight", keys: `${mod}+Shift+H` },
  ];
}

export function linkKeys(): string {
  return `${currentModifierLabel()}+K`;
}

export function toggleMark(editor: Editor, mark: MarkName): void {
  editor.chain().focus().toggleMark(mark).run();
}

/** The selection is formattable text: not empty, not in a code block, not a node (image, embed). */
export function canFormat(editor: Editor): boolean {
  const { selection } = editor.state;
  if (selection.empty) return false;
  if (selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code) return false;
  // A node selection (image, board embed) has nothing to format.
  if ("node" in selection && selection.node) return false;
  let hasText = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isText) hasText = true;
    return !hasText;
  });
  return hasText;
}

/** What the user typed into the link field: a web/mail link, or null (then it's a page search). */
export function normaliseUrl(input: string): string | null {
  const value = input.trim();
  if (!value || value.startsWith("[[")) return null;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(value)) return `mailto:${value}`;
  // "example.com/path": a domain-looking first segment.
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)) return `https://${value}`;
  return null;
}

/** Link the selection to `href` (one undo step). */
export function setLink(editor: Editor, href: string): void {
  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

export function removeLink(editor: Editor): void {
  editor.chain().focus().extendMarkRange("link").unsetLink().run();
}

/**
 * Turn the selected text into a `[[wiki link]]` to a page; the text stays
 * as the alias unless it already reads as the target.
 */
export function linkSelectionToPage(editor: Editor, target: string, alias: string): void {
  const { from, to } = editor.state.selection;
  const text = editor.state.doc.textBetween(from, to, " ").trim();
  const shown = alias || (text && text.toLowerCase() !== target.toLowerCase() ? text : "");
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, { type: "wikiLink", attrs: { targetTitle: target, alias: shown, heading: "" } })
    .run();
}

let linkFieldOpener: (() => boolean) | null = null;

/** The selection toolbar registers how to open its link field. */
export function setLinkFieldOpener(next: (() => boolean) | null): void {
  linkFieldOpener = next;
}

/** Open the toolbar's link field for the selection; false when there's nothing to link. */
export function openLinkField(): boolean {
  return linkFieldOpener?.() ?? false;
}

/**
 * Mod+K with text selected links it (Notion). Without a selection the key
 * isn't handled here, so the app's Cmd+K search opens as before.
 */
export const LinkShortcut = Extension.create({
  name: "linkShortcut",
  addKeyboardShortcuts() {
    return {
      "Mod-k": () => (canFormat(this.editor) ? openLinkField() : false),
    };
  },
});
