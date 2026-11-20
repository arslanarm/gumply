/**
 * Slash-menu catalogue. Keys double as `data-testid="slash-menu-item-<key>"`
 * values (UI contract in wiki `spec/e2e-tests`).
 */
import type { Editor, Range } from "@tiptap/core";
import { requestAttachmentPicker } from "./attachments/store.js";

export interface SlashItem {
  key: string;
  title: string;
  hint: string;
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    key: "heading-1",
    title: "Heading 1",
    hint: "Big section heading",
    keywords: ["h1", "title", "heading"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    key: "heading-2",
    title: "Heading 2",
    hint: "Medium section heading",
    keywords: ["h2", "subtitle", "heading"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    key: "heading-3",
    title: "Heading 3",
    hint: "Small section heading",
    keywords: ["h3", "heading"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    key: "bullet-list",
    title: "Bullet list",
    hint: "Unordered list",
    keywords: ["ul", "bullet", "unordered", "list"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    key: "ordered-list",
    title: "Numbered list",
    hint: "Ordered list",
    keywords: ["ol", "number", "ordered", "list"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    key: "todo",
    title: "To-do",
    hint: "Task with a checkbox",
    keywords: ["todo", "task", "checkbox", "checklist"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    key: "quote",
    title: "Quote",
    hint: "Capture a quotation",
    keywords: ["quote", "blockquote", "citation"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    key: "code",
    title: "Code block",
    hint: "Monospaced code",
    keywords: ["code", "pre", "snippet"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    key: "image",
    title: "Image",
    hint: "Upload an image",
    keywords: ["image", "photo", "picture", "upload", "attachment"],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestAttachmentPicker("image");
    },
  },
  {
    key: "file",
    title: "File",
    hint: "Attach a file",
    keywords: ["file", "attachment", "upload", "pdf"],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestAttachmentPicker("file");
    },
  },
  {
    key: "divider",
    title: "Divider",
    hint: "Horizontal rule",
    keywords: ["divider", "hr", "rule", "separator", "line"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

/** Case-insensitive filter over title, key and keywords, preserving order. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...items];

  return items.filter((item) => {
    if (item.title.toLowerCase().includes(needle)) return true;
    if (item.key.toLowerCase().includes(needle)) return true;
    return item.keywords.some((keyword) => keyword.toLowerCase().includes(needle));
  });
}
