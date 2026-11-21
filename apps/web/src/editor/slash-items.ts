/**
 * Slash-menu catalogue. Keys double as `data-testid="slash-menu-item-<key>"`
 * values (UI contract in wiki `spec/e2e-tests`).
 */
import type { Editor, Range } from "@tiptap/core";
import { requestAttachmentPicker } from "./attachments/store.js";
import { requestEmojiPicker } from "./emoji/store.js";
import { requestWhiteboard } from "./whiteboard-link.js";
import { t } from "../i18n/index.js";
import { requestPagePreviewPicker } from "./wikilink/suggestion-extension.js";

export interface SlashItem {
  key: string;
  readonly title: string;
  readonly hint: string;
  readonly keywords: string[];
  run: (editor: Editor, range: Range) => void;
}

/** English keywords plus the current language's (comma-separated in the message file). */
function withLocalKeywords(english: string[], local: string): string[] {
  const extra = local.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  return extra.length > 0 ? [...english, ...extra] : english;
}

/**
 * Titles, hints and keywords are getters: they're read when the menu renders,
 * so they follow the interface language (#7h5utv23).
 */
export const SLASH_ITEMS: SlashItem[] = [
  {
    key: "heading-1",
    get title() {
      return t("slash.heading1.title");
    },
    get hint() {
      return t("slash.heading1.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["h1", "title", "heading"], t("slash.heading1.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    key: "heading-2",
    get title() {
      return t("slash.heading2.title");
    },
    get hint() {
      return t("slash.heading2.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["h2", "subtitle", "heading"], t("slash.heading2.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    key: "heading-3",
    get title() {
      return t("slash.heading3.title");
    },
    get hint() {
      return t("slash.heading3.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["h3", "heading"], t("slash.heading3.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    key: "bullet-list",
    get title() {
      return t("slash.bulletList.title");
    },
    get hint() {
      return t("slash.bulletList.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["ul", "bullet", "unordered", "list"], t("slash.bulletList.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    key: "ordered-list",
    get title() {
      return t("slash.orderedList.title");
    },
    get hint() {
      return t("slash.orderedList.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["ol", "number", "ordered", "list"], t("slash.orderedList.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    key: "todo",
    get title() {
      return t("slash.todo.title");
    },
    get hint() {
      return t("slash.todo.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["todo", "task", "checkbox", "checklist"], t("slash.todo.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    key: "quote",
    get title() {
      return t("slash.quote.title");
    },
    get hint() {
      return t("slash.quote.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["quote", "blockquote", "citation"], t("slash.quote.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    key: "callout",
    get title() {
      return t("slash.callout.title");
    },
    get hint() {
      return t("slash.callout.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["callout", "admonition", "box", "note", "info", "highlight"], t("slash.callout.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCallout({ type: "note" }).run(),
  },
  {
    key: "toggle",
    get title() {
      return t("slash.toggle.title");
    },
    get hint() {
      return t("slash.toggle.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["toggle", "collapse", "collapsible", "fold", "details", "expand", "dropdown"], t("slash.toggle.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCallout({ type: "note", fold: "-", textInto: "title" }).run(),
  },
  {
    key: "note",
    get title() {
      return t("slash.note.title");
    },
    get hint() {
      return t("slash.note.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["note", "callout"], t("slash.note.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCallout({ type: "note" }).run(),
  },
  {
    key: "tip",
    get title() {
      return t("slash.tip.title");
    },
    get hint() {
      return t("slash.tip.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["tip", "hint", "callout"], t("slash.tip.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCallout({ type: "tip" }).run(),
  },
  {
    key: "warning",
    get title() {
      return t("slash.warning.title");
    },
    get hint() {
      return t("slash.warning.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["warning", "caution", "callout"], t("slash.warning.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCallout({ type: "warning" }).run(),
  },
  {
    key: "code",
    get title() {
      return t("slash.code.title");
    },
    get hint() {
      return t("slash.code.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["code", "pre", "snippet"], t("slash.code.keywords"));
    },
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    key: "table",
    get title() {
      return t("slash.table.title");
    },
    get hint() {
      return t("slash.table.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["table", "grid", "rows", "columns", "spreadsheet"], t("slash.table.keywords"));
    },
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    key: "emoji",
    get title() {
      return t("slash.emoji.title");
    },
    get hint() {
      return t("slash.emoji.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["emoji", "smiley", "icon", "face"], t("slash.emoji.keywords"));
    },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestEmojiPicker();
    },
  },
  {
    key: "image",
    get title() {
      return t("slash.image.title");
    },
    get hint() {
      return t("slash.image.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["image", "photo", "picture", "upload", "attachment"], t("slash.image.keywords"));
    },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestAttachmentPicker("image");
    },
  },
  {
    key: "file",
    get title() {
      return t("slash.file.title");
    },
    get hint() {
      return t("slash.file.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["file", "attachment", "upload", "pdf"], t("slash.file.keywords"));
    },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestAttachmentPicker("file");
    },
  },
  {
    key: "whiteboard",
    get title() {
      return t("slash.whiteboard.title");
    },
    get hint() {
      return t("slash.whiteboard.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["whiteboard", "board", "canvas", "miro", "sticky", "diagram", "draw", "new board here"], t("slash.whiteboard.keywords"));
    },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestWhiteboard();
    },
  },
  {
    key: "board-template",
    get title() {
      return t("slash.boardTemplate.title");
    },
    get hint() {
      return t("slash.boardTemplate.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["template", "whiteboard", "board", "kanban", "mind map", "retrospective", "retro", "flowchart", "weekly", "plan"], t("slash.boardTemplate.keywords"));
    },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      requestWhiteboard({ pickTemplate: true });
    },
  },
  {
    key: "page-preview",
    get title() {
      return t("slash.pagePreview.title");
    },
    get hint() {
      return t("slash.pagePreview.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["embed", "page", "preview", "transclude", "synced", "include", "section", "block"], t("slash.pagePreview.keywords"));
    },
    run: (editor, range) => {
      // `![[` opens the page menu; picking a page then offers its outline.
      requestPagePreviewPicker();
      editor.chain().focus().deleteRange(range).insertContent("![[").run();
    },
  },
  {
    key: "embed-whiteboard",
    get title() {
      return t("slash.embedWhiteboard.title");
    },
    get hint() {
      return t("slash.embedWhiteboard.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["whiteboard", "board", "canvas", "embed", "existing", "miro", "diagram"], t("slash.embedWhiteboard.keywords"));
    },
    // `![[` opens the link menu with boards only (D30).
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertContent("![[").run(),
  },
  {
    key: "divider",
    get title() {
      return t("slash.divider.title");
    },
    get hint() {
      return t("slash.divider.hint");
    },
    // English words always match; the current language adds its own.
    get keywords() {
      return withLocalKeywords(["divider", "hr", "rule", "separator", "line"], t("slash.divider.keywords"));
    },
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
