import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor as TipTapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { Attachment, Page, PageMeta } from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { api, ApiRequestError } from "../api/client.js";
import { BlockGutter } from "./BlockGutter.js";
import { EmojiMenu } from "./EmojiMenu.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { LinkMenu } from "./LinkMenu.js";
import { SlashMenu } from "./SlashMenu.js";
import { TableControls } from "./TableControls.js";
import { Autosave, type SaveState } from "../editor/autosave.js";
import { newWriterId, registerSaver } from "../lib/pending-saves.js";
import {
  findUploadNode,
  finishUpload,
  insertUploadPlaceholder,
  removeUpload,
} from "../editor/attachments/insert.js";
import { ImageBlock, FileAttachment } from "../editor/attachments/nodes.js";
import { InlineImage } from "../editor/attachments/inline-image.js";
import { setAttachmentPicker } from "../editor/attachments/store.js";
import { BlockEditing } from "../editor/block-editing.js";
import { NotionCodeBlock } from "../editor/code-block.js";
import { pastedTablesToMarkdown } from "../editor/paste-table.js";
import { EmptyLineParagraph } from "../editor/empty-lines.js";
import { createEmojiExtension, type EmojiHandlers } from "../editor/emoji/extension.js";
import { setEmojiPickerOpener } from "../editor/emoji/store.js";
import { setBoardEmbedActions, setWhiteboardCreator, type WhiteboardRequest } from "../editor/whiteboard-link.js";
import { setPageTemplateHandler, type PageTemplateRequest } from "../editor/page-template.js";
import { BoardEmbed, boardEmbedAttrs } from "../editor/board-embed/node.js";
import { BaseEmbed } from "../editor/base-embed/node.js";
import { setDatabaseCreator } from "../editor/base-embed/actions.js";
import { linkTargetFor } from "@gumply/core";
import { PageEmbed } from "../editor/page-embed/node.js";
import { BlockIdChips } from "../editor/page-embed/block-ids.js";
import { setTagOpener, TagChips } from "../editor/tag-chip.js";
import { Highlight, InnermostCode } from "../editor/highlight.js";
import { ColorMarks } from "../editor/color.js";
import { LinkShortcut } from "../editor/formatting.js";
import { SelectionToolbar } from "./SelectionToolbar.js";
import { EditorContextMenu } from "./EditorContextMenu.js";
import type { EmojiEntry } from "../lib/emoji/data.js";
import { MarkdownLink } from "../editor/link.js";
import {
  MarkdownHeading,
  MarkdownHorizontalRule,
  MarkdownMarkup,
  MarkdownOrderedList,
} from "../editor/raw-markdown/markup.js";
import { RawBlock, RawInline } from "../editor/raw-markdown/nodes.js";
import { Callout, CalloutTitle } from "../editor/callout/callout.js";
import { lastParsedTableSources } from "../editor/raw-markdown/markdown-plugin.js";
import {
  GumplyTable,
  GumplyTableCell,
  GumplyTableHeader,
  GumplyTableRow,
  registerTableSources,
} from "../editor/table/table.js";
import { MarkdownHardBreak, MarkdownText } from "../editor/raw-markdown/text.js";
import { MarkdownBulletList, MarkdownTaskList, setListStyle } from "../editor/raw-markdown/list-style.js";
import { MarkdownTaskListFix, TaskListTight } from "../editor/markdown-task-list-fix.js";
import { ShortcutHistory } from "../editor/shortcut-history.js";
import { createSlashExtension, type SlashHandlers } from "../editor/slash-extension.js";
import type { SlashItem } from "../editor/slash-items.js";
import { AccessibleTaskItem } from "../editor/task-item.js";
import { TaskShortcut } from "../editor/task-shortcut.js";
import { setWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { headingKey } from "@gumply/core";
import { WikiLink } from "../editor/wikilink/node.js";
import {
  createWikiLinkExtension,
  type LinkMenuHandlers,
} from "../editor/wikilink/suggestion-extension.js";
import { errorMessage } from "../lib/errors.js";
import type { LinkSuggestion } from "../lib/wikilinks.js";
import { normalizeEditorMarkdown } from "../lib/markdown.js";
import { taskCheckboxLabel } from "../lib/task.js";
import { createExitTopExtension, focusStartNow } from "../editor/title-navigation.js";
import { t } from "../i18n/index.js";

export interface EditorControls {
  /** Id of the page this editor shows (controls outlive a page switch). */
  pageId: string;
  flush: () => Promise<void>;
  focusBody: () => void;
  /** Current Markdown buffer (for Restore page). */
  getMarkdown: () => string;
  /** Current selection, used to restore the caret after an external reload. */
  getSelection: () => { from: number; to: number } | null;
  /** Focus the body at a clamped position. */
  focusAt: (position: number) => void;
  /** True while local edits are newer than the last save. */
  isDirty: () => boolean;
  /** Force-save the current buffer after a conflict ("Keep mine"). */
  keepMine: () => Promise<void>;
  /**
   * The file was recreated from this buffer (Restore page): adopt its version
   * and save anything still pending against it, without a remount.
   */
  adoptRecreatedFile: (id: string, updated: string) => Promise<void>;
}

export interface EditorProps {
  page: Page;
  pages: readonly PageMeta[];
  onSaveState: (state: SaveState) => void;
  /** After a save: the server's page and the id it was saved under. */
  onSaved?: (page: Page, savedId: string) => void;
  onConflictBackup?: (path: string) => void;
  onReady?: (controls: EditorControls) => void;
  onOpenLink: (link: { targetTitle: string; heading: string }) => void;
  onCreateLink: (title: string) => void;
  headingToReveal?: string | null;
  onHeadingResult?: (found: boolean) => void;
  onAttachmentError?: (message: string) => void;
  /** ArrowUp / Backspace at the very start of the body: go to the title. */
  onExitTop?: () => void;
  /**
   * `/whiteboard`, `/template` and Create on a missing embed: create a board
   * inside this page (from a template picked in the gallery with
   * `pickTemplate`); resolves to it (or null).
   */
  onCreateBoard?: (request: WhiteboardRequest) => Promise<PageMeta | null>;
  /** `/database` (D34): create a database view inside this page; the editor embeds it. */
  onCreateBase?: () => Promise<PageMeta | null>;
  /** A click on an inline `#tag` chip (#ux5cukze). */
  onOpenTag?: (tag: string) => void;
  /** `/template` → Insert page template… (v0.7 C, #5hrsrqsj). */
  onInsertTemplate?: (request: PageTemplateRequest) => void;
  /** Show only (a page in the trash, #ppag3ugh): not editable, never saved. */
  readOnly?: boolean;
}

interface SlashMenuState {
  items: SlashItem[];
  index: number;
  left: number;
  top: number;
  command: (item: SlashItem) => void;
}

interface LinkMenuState {
  items: LinkSuggestion[];
  index: number;
  left: number;
  top: number;
  command: (item: LinkSuggestion) => void;
}

interface EmojiMenuState {
  items: EmojiEntry[];
  index: number;
  left: number;
  top: number;
  command: (item: EmojiEntry) => void;
}

interface MarkdownStorage {
  markdown?: { getMarkdown?: () => string };
}

function readMarkdown(editor: TipTapEditor): string {
  const storage = editor.storage as unknown as MarkdownStorage;
  return normalizeEditorMarkdown(storage.markdown?.getMarkdown?.() ?? "");
}

function menuRect(props: { clientRect?: (() => DOMRect | null) | null }) {
  const rect = props.clientRect?.() ?? null;
  return { left: rect?.left ?? 0, top: (rect?.bottom ?? 0) + 6 };
}

/** TipTap block editor with `/`, `[[` menus and debounced autosave. */
export function Editor({
  page,
  pages,
  onSaveState,
  onSaved,
  onConflictBackup,
  onReady,
  onOpenLink,
  onCreateLink,
  headingToReveal,
  onHeadingResult,
  onAttachmentError,
  onExitTop,
  onCreateBoard,
  onCreateBase,
  onInsertTemplate,
  onOpenTag,
  readOnly = false,
}: EditorProps) {
  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<SlashMenuState | null>(null);
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const linkMenuRef = useRef<LinkMenuState | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pickerKind = useRef<"image" | "file">("file");
  const uploadRef = useRef<(files: File[], pos: number) => void>(() => {});
  const editorRef = useRef<TipTapEditor | null>(null);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onConflictBackupRef = useRef(onConflictBackup);
  onConflictBackupRef.current = onConflictBackup;
  const onHeadingResultRef = useRef(onHeadingResult);
  onHeadingResultRef.current = onHeadingResult;
  const onAttachmentErrorRef = useRef(onAttachmentError);
  onAttachmentErrorRef.current = onAttachmentError;
  const onCreateBoardRef = useRef(onCreateBoard);
  onCreateBoardRef.current = onCreateBoard;
  const onCreateBaseRef = useRef(onCreateBase);
  onCreateBaseRef.current = onCreateBase;
  const onInsertTemplateRef = useRef(onInsertTemplate);
  onInsertTemplateRef.current = onInsertTemplate;
  useEffect(() => {
    setPageTemplateHandler((request) => onInsertTemplateRef.current?.(request));
  }, []);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const onOpenTagRef = useRef(onOpenTag);
  onOpenTagRef.current = onOpenTag;
  useEffect(() => setTagOpener((tag) => onOpenTagRef.current?.(tag)), []);
  const onExitTopRef = useRef(onExitTop);
  onExitTopRef.current = onExitTop;
  const exitTopExtension = useMemo(() => createExitTopExtension(onExitTopRef), []);
  const versionRef = useRef(page.updated);
  // D20: a rename changes the id while this editor stays mounted; always save
  // to the current one.
  const pageIdRef = useRef(page.id);
  pageIdRef.current = page.id;
  const forceRef = useRef(false);

  // A rename/reload from App updates the version this editor must send, but
  // never back to an older one than this editor already saved (#d5e4mawv):
  // a stale list from the disk poll would turn the next save into a 409.
  useEffect(() => {
    if (!versionRef.current || page.updated > versionRef.current) versionRef.current = page.updated;
  }, [page.updated]);
  // Identifies this editor's saves to the server (see spec/api `writer`).
  const writerRef = useRef(newWriterId());

  const autosave = useMemo(() => {
    const instance = new Autosave({
      save: async (content) => {
        const force = forceRef.current;
        try {
          const savedId = pageIdRef.current;
          const updated = await api.updatePage(savedId, {
            content,
            expectedUpdated: versionRef.current,
            writer: writerRef.current,
            ...(force ? { force: true } : {}),
          });
          forceRef.current = false;
          versionRef.current = updated.updated;
          // Report which page this was: by now another page may be open.
          onSavedRef.current?.(updated, savedId);
          if (updated.conflictBackup) onConflictBackupRef.current?.(updated.conflictBackup);
        } catch (error) {
          if (!force) forceRef.current = false;
          throw error;
        }
      },
      // Leaving the page (#3t6v62cb): a keepalive PUT, always conditional.
      // After a write still in flight, the version we hold is the one that
      // write replaced; the server accepts it from this same editor (`writer`)
      // only while the file is still exactly that write (#d5e4mawv).
      exitSave: (content) => {
        const savedId = pageIdRef.current;
        const request = api.updatePageOnExit(savedId, {
          content,
          expectedUpdated: versionRef.current,
          writer: writerRef.current,
        });
        // If the page stays after all (a `mailto:` link fires beforeunload),
        // the app learns the new version like after any save, so the disk
        // poll never mistakes our own write for an outside change.
        return (
          request?.then((updated) => {
            versionRef.current = updated.updated;
            onSavedRef.current?.(updated, savedId);
          }) ?? null
        );
      },
      isConflict: (error) => error instanceof ApiRequestError && error.status === 409,
      onState: (state) => onSaveStateRef.current(state),
    });
    instance.reset(page.content);
    return instance;
    // One instance per mount: App keys the editor by page session, and a
    // rename (new id, same page) must not reset it to stale content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Node views read page resolution and attachment metadata from this store.
  useEffect(() => {
    setWikiLinkEnvironment({
      pageId: page.id,
      pages,
      attachments,
      ...(page.fileLinks ? { fileLinks: page.fileLinks } : {}),
      openLink: onOpenLink,
      createLink: onCreateLink,
      reportError: (message) => onAttachmentErrorRef.current?.(message),
      addAttachment: (attachment) =>
        setAttachments((list) =>
          list.some((item) => item.path === attachment.path) ? list : [...list, attachment],
        ),
    });
  }, [page.id, page.fileLinks, pages, attachments, onOpenLink, onCreateLink]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAttachments()
      .then((list) => {
        if (!cancelled) setAttachments(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The slash items ask this picker to open a file dialog.
  useEffect(() => {
    setAttachmentPicker((kind) => {
      pickerKind.current = kind;
      const input = fileInputRef.current;
      if (!input) return;
      input.value = "";
      input.accept = kind === "image" ? "image/*" : "";
      input.click();
    });
  }, []);

  const refreshAttachments = useCallback(async () => {
    try {
      setAttachments(await api.listAttachments());
    } catch {
      // The editor keeps working with the rows it already has.
    }
  }, []);

  const uploadFiles = useCallback(
    async (files: File[], pos: number) => {
      const editor = editorRef.current;
      if (!editor) return;
      let insertPos = pos;
      for (const file of files.slice(0, 12)) {
        if (file.size > 25 * 1024 * 1024) {
          onAttachmentErrorRef.current?.("File is too large (max 25 MB)");
          continue;
        }

        const { id } = insertUploadPlaceholder(editor, file, insertPos);
        const placeholder = findUploadNode(editor.state.doc, id);
        if (placeholder) insertPos = placeholder.pos + placeholder.node.nodeSize;

        try {
          const attachment = await api.uploadAttachment(file);
          finishUpload(editor, id, attachment);
          await refreshAttachments();
        } catch (error) {
          removeUpload(editor, id);
          onAttachmentErrorRef.current?.(errorMessage(error));
        }
      }
    },
    [refreshAttachments],
  );

  useEffect(() => {
    uploadRef.current = (files, pos) => void uploadFiles(files, pos);
  }, [uploadFiles]);

  // ---------- `/` menu ----------

  const showMenu = (props: SuggestionProps<SlashItem>) => {
    const next: SlashMenuState = {
      items: props.items,
      index: 0,
      ...menuRect(props),
      command: (item) => props.command(item),
    };
    menuRef.current = next;
    setMenu(next);
  };

  const hideMenu = () => {
    menuRef.current = null;
    setMenu(null);
  };

  const handlersRef = useRef<SlashHandlers>({
    onStart: showMenu,
    onUpdate: showMenu,
    onKeyDown: () => false,
    onExit: hideMenu,
  });

  handlersRef.current = {
    onStart: showMenu,
    onUpdate: showMenu,
    onExit: hideMenu,
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const current = menuRef.current;
      if (!current || current.items.length === 0) return false;

      if (event.key === "Escape") {
        hideMenu();
        return true;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const index = (current.index + delta + current.items.length) % current.items.length;
        const next = { ...current, index };
        menuRef.current = next;
        setMenu(next);
        return true;
      }

      if (event.key === "Enter") {
        const item = current.items[current.index];
        if (!item) return false;
        hideMenu();
        current.command(item);
        return true;
      }

      return false;
    },
  };

  const slashExtension = useMemo(() => createSlashExtension(handlersRef), []);

  // ---------- `[[` menu ----------

  const showLinkMenu = (props: SuggestionProps<LinkSuggestion>) => {
    const next: LinkMenuState = {
      items: props.items,
      index: 0,
      ...menuRect(props),
      command: (item) => props.command(item),
    };
    linkMenuRef.current = next;
    setLinkMenu(next);
  };

  const hideLinkMenu = () => {
    linkMenuRef.current = null;
    setLinkMenu(null);
  };

  const linkHandlersRef = useRef<LinkMenuHandlers>({
    onStart: showLinkMenu,
    onUpdate: showLinkMenu,
    onKeyDown: () => false,
    onExit: hideLinkMenu,
  });

  linkHandlersRef.current = {
    onStart: showLinkMenu,
    onUpdate: showLinkMenu,
    onExit: hideLinkMenu,
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const current = linkMenuRef.current;
      if (!current || current.items.length === 0) return false;

      if (event.key === "Escape") {
        hideLinkMenu();
        return true;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const index = (current.index + delta + current.items.length) % current.items.length;
        const next = { ...current, index };
        linkMenuRef.current = next;
        setLinkMenu(next);
        return true;
      }

      if (event.key === "Enter") {
        const item = current.items[current.index];
        if (!item) return false;
        hideLinkMenu();
        current.command(item);
        return true;
      }

      return false;
    },
  };

  const wikiLinkExtension = useMemo(
    () => createWikiLinkExtension(linkHandlersRef),
    [],
  );

  // ---------- `:` emoji suggestions (#6v8tyxfd) ----------

  const [emojiMenu, setEmojiMenu] = useState<EmojiMenuState | null>(null);
  const emojiMenuRef = useRef<EmojiMenuState | null>(null);
  // Esc keeps the typed text and closes the menu for this `:query` only.
  const emojiDismissedAt = useRef<number | null>(null);

  const showEmojiMenu = (props: SuggestionProps<EmojiEntry>) => {
    if (emojiDismissedAt.current === props.range.from || props.items.length === 0) {
      emojiMenuRef.current = null;
      setEmojiMenu(null);
      return;
    }
    const previous = emojiMenuRef.current;
    const next: EmojiMenuState = {
      items: props.items,
      index: previous ? Math.min(previous.index, props.items.length - 1) : 0,
      ...menuRect(props),
      command: (item) => props.command(item),
    };
    if (previous && previous.items !== props.items) next.index = 0;
    emojiMenuRef.current = next;
    setEmojiMenu(next);
  };

  const hideEmojiMenu = () => {
    emojiMenuRef.current = null;
    setEmojiMenu(null);
  };

  const emojiHandlersRef = useRef<EmojiHandlers>({
    onStart: showEmojiMenu,
    onUpdate: showEmojiMenu,
    onKeyDown: () => false,
    onExit: hideEmojiMenu,
  });

  emojiHandlersRef.current = {
    onStart: (props) => {
      emojiDismissedAt.current = null;
      showEmojiMenu(props);
    },
    onUpdate: showEmojiMenu,
    onExit: () => {
      emojiDismissedAt.current = null;
      hideEmojiMenu();
    },
    onKeyDown: ({ event, range }: SuggestionKeyDownProps) => {
      const current = emojiMenuRef.current;
      if (!current || current.items.length === 0) return false;
      if (event.key === "Escape") {
        emojiDismissedAt.current = range.from;
        hideEmojiMenu();
        return true;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const index = (current.index + delta + current.items.length) % current.items.length;
        const next = { ...current, index };
        emojiMenuRef.current = next;
        setEmojiMenu(next);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = current.items[current.index];
        if (!item) return false;
        hideEmojiMenu();
        current.command(item);
        return true;
      }
      return false;
    },
  };

  const emojiExtension = useMemo(() => createEmojiExtension(emojiHandlersRef), []);

  // `/emoji`: the full picker at the caret.
  const [emojiPicker, setEmojiPicker] = useState<{ left: number; top: number; pos: number } | null>(
    null,
  );
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);

  // `/whiteboard` → New board here (and `/template`): create the board, then
  // embed it where the command was typed (D30).
  useEffect(() => {
    setWhiteboardCreator((request) => {
      const instance = editorRef.current;
      const create = onCreateBoardRef.current;
      if (!instance || !create) return;
      const pos = instance.state.selection.from;
      void create(request).then((board) => {
        const current = editorRef.current;
        if (!board || !current || current.isDestroyed) return;
        const pages = pagesRef.current.some((item) => item.id === board.id)
          ? pagesRef.current
          : [...pagesRef.current, board];
        const at = Math.min(pos, current.state.doc.content.size);
        current
          .chain()
          .focus()
          .insertContentAt(at, { type: "boardEmbed", attrs: boardEmbedAttrs(board, pages) })
          .run();
      });
    });
    setBoardEmbedActions({
      createBoard: async (title) => (await onCreateBoardRef.current?.({ title })) ?? null,
    });
    setDatabaseCreator(() => {
      const instance = editorRef.current;
      const create = onCreateBaseRef.current;
      if (!instance || !create) return;
      const pos = instance.state.selection.from;
      void create().then((base) => {
        const current = editorRef.current;
        if (!base || !current || current.isDestroyed) return;
        const pages = pagesRef.current.some((item) => item.id === base.id) ? pagesRef.current : [...pagesRef.current, base];
        const at = Math.min(pos, current.state.doc.content.size);
        current
          .chain()
          .focus()
          .insertContentAt(at, { type: "baseEmbed", attrs: { target: linkTargetFor(base, pages).target, view: "", raw: "" } })
          .run();
      });
    });
  }, []);

  useEffect(() => {
    setEmojiPickerOpener(() => {
      const instance = editorRef.current;
      if (!instance) return;
      const pos = instance.state.selection.from;
      const coords = instance.view.coordsAtPos(pos);
      const height = 420;
      const top =
        coords.bottom + 6 + height > window.innerHeight
          ? Math.max(8, coords.top - 6 - height)
          : coords.bottom + 6;
      setEmojiPicker({ left: Math.min(coords.left, window.innerWidth - 380), top, pos });
    });
  }, []);

  useEffect(() => {
    if (!emojiPicker) return;
    const onPointerDown = (event: MouseEvent) => {
      if (emojiPickerRef.current?.contains(event.target as Node)) return;
      setEmojiPicker(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [emojiPicker]);

  // ---------- editor ----------

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: false,
        orderedList: false,
        horizontalRule: false,
        paragraph: false,
        text: false,
        hardBreak: false,
        bulletList: false,
        codeBlock: false,
        // Registered below as the innermost mark (editor/highlight.ts).
        code: false,
      }),
      InnermostCode,
      NotionCodeBlock,
      MarkdownBulletList,
      GumplyTable,
      GumplyTableRow,
      GumplyTableHeader,
      GumplyTableCell,
      MarkdownHeading.configure({ levels: [1, 2, 3] }),
      MarkdownOrderedList,
      MarkdownHorizontalRule,
      MarkdownMarkup,
      EmptyLineParagraph,
      MarkdownText,
      MarkdownHardBreak,
      RawBlock,
      RawInline,
      Callout,
      CalloutTitle,
      MarkdownLink,
      MarkdownTaskList,
      AccessibleTaskItem.configure({
        nested: true,
        a11y: {
          checkboxLabel: (node, checked) => taskCheckboxLabel(node.textContent, checked),
        },
      }),
      Placeholder.configure({
        showOnlyCurrent: true,
        placeholder: ({ node, editor: instance, pos }) => {
          if (node.type.name === "heading") return `Heading ${node.attrs.level}`;
          if (node.type.name !== "paragraph") return "";
          // Only top-level paragraphs get the hint (list items/quote lines don't).
          return instance.state.doc.resolve(pos + 1).depth === 1
            ? "Type '/' for commands…"
            : "";
        },
      }),
      ImageBlock,
      BoardEmbed,
      BaseEmbed,
      PageEmbed,
      TagChips,
      BlockIdChips,
      Highlight,
      ...ColorMarks,
      LinkShortcut,
      InlineImage,
      FileAttachment,
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        transformPastedText: true,
        tightLists: true,
      }),
      WikiLink,
      slashExtension,
      wikiLinkExtension,
      emojiExtension,
      BlockEditing,
      MarkdownTaskListFix,
      TaskListTight,
      TaskShortcut,
      ShortcutHistory,
      exitTopExtension,
    ],
    content: page.content,
    editorProps: {
      attributes: {
        class: "gumply-editor",
        "aria-label": t("page.contentLabel"),
        "data-testid": "editor-content",
      },
      // Pasted HTML tables become a GFM table block (#y5iqswjf).
      transformPastedHTML: (html) =>
        pastedTablesToMarkdown(html, (markdown) => {
          const storage = editorRef.current?.storage as unknown as {
            markdown?: { parser?: { parse(content: string): string } };
          };
          return storage?.markdown?.parser?.parse(markdown) ?? markdown;
        }),
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        // A GFM cell holds one line: multi-line text pasted into a table
        // cell is joined with spaces instead of splitting the table (#7witbbun).
        const instance = editorRef.current;
        if (files.length === 0 && instance?.isActive("table")) {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (/\n/.test(text.trim())) {
            event.preventDefault();
            instance.commands.insertContent({ type: "text", text: text.trim().replace(/\s*\n+\s*/g, " ") });
            return true;
          }
        }
        if (files.length === 0) return false;
        event.preventDefault();
        uploadRef.current(files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        uploadRef.current(files, at?.pos ?? view.state.selection.from);
        return true;
      },
    },
    onCreate: ({ editor: instance }) => {
      // Write lists back with the page's own bullet marker and indent.
      setListStyle(instance, page.content);
      // Untouched tables are written back byte-for-byte (#7witbbun).
      registerTableSources(instance.state.doc, lastParsedTableSources());
    },
    onUpdate: ({ editor: instance }) => {
      if (readOnly) return;
      autosave.schedule(readMarkdown(instance));
    },
  });

  editorRef.current = editor;

  useEffect(() => {
    // Reload, close and quit flush this page too (#3t6v62cb).
    const unregister = registerSaver({
      isDirty: () => autosave.isDirty(),
      hasFailed: () => autosave.hasFailed(),
      flush: () => autosave.flush(),
      flushOnExit: () => autosave.flushOnExit(),
    });
    return () => {
      unregister();
      autosave.dispose();
    };
  }, [autosave]);

  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void autosave.flush();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [autosave, readOnly]);

  useEffect(() => {
    if (!editor || readOnly) return;
    onReady?.({
      flush: () => autosave.flush(),
      pageId: page.id,
      // Synchronous on purpose: TipTap's focus() command waits a frame, and
      // keys typed right after Enter in the title were lost meanwhile (#d636gdxx).
      focusBody: () => focusStartNow(editor),
      getMarkdown: () => readMarkdown(editor),
      getSelection: () => ({
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      }),
      focusAt: (position: number) => {
        const max = editor.state.doc.content.size;
        editor.commands.focus(Math.min(Math.max(position, 0), max));
      },
      isDirty: () => autosave.isDirty(),
      keepMine: async () => {
        forceRef.current = true;
        await autosave.retry();
      },
      adoptRecreatedFile: async (id: string, updated: string) => {
        // Set both now: App's state update for them renders later.
        pageIdRef.current = id;
        versionRef.current = updated;
        await autosave.retry();
      },
    });
  }, [editor, autosave, onReady, page.id, readOnly]);

  // `[[Page#Heading]]`: scroll to the heading, or report it missing.
  useEffect(() => {
    if (!editor || !headingToReveal) return;

    // `#^id` (#5dpxwac4): the block that ends with ` ^id`; an id alone on a
    // line names the block above it. Headings match by their words.
    const block = headingToReveal.trim().startsWith("^") ? headingToReveal.trim().slice(1) : null;
    const wanted = headingKey(headingToReveal);
    const marker = block ? new RegExp(`(?:^|\\s)\\^${block.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) : null;
    let headingPos: number | null = null;
    let previousBlock: number | null = null;

    editor.state.doc.descendants((node, pos) => {
      if (headingPos !== null) return false;
      if (marker) {
        if (!node.isTextblock) return true;
        const text = node.textContent;
        if (marker.test(text)) {
          headingPos = text.trim().startsWith("^") && previousBlock !== null ? previousBlock : pos;
          return false;
        }
        if (text.trim() !== "") previousBlock = pos;
        return false;
      }
      if (node.type.name === "heading" && headingKey(node.textContent) === wanted) {
        headingPos = pos;
        return false;
      }
      return true;
    });

    if (headingPos === null) {
      onHeadingResultRef.current?.(false);
      return;
    }

    const dom = editor.view.nodeDOM(headingPos);
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    onHeadingResultRef.current?.(true);
  }, [editor, headingToReveal]);

  return (
    <div className={`editor-host${readOnly ? " is-read-only" : ""}`}>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        data-testid="attachment-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0 && editor) {
            uploadRef.current(files, editor.state.selection.from);
          }
        }}
      />
      <EditorContent editor={editor} />
      {editor && !readOnly ? <BlockGutter editor={editor} /> : null}
      {editor && !readOnly ? <TableControls editor={editor} /> : null}
      {/* A trashed page is read-only: no formatting, and the browser's own
          right-click menu (Copy, Select all) instead of ours (#bg3cb83t). */}
      {editor && !readOnly ? <SelectionToolbar editor={editor} /> : null}
      {editor && !readOnly ? <EditorContextMenu editor={editor} /> : null}
      {menu ? (
        <SlashMenu
          items={menu.items}
          index={menu.index}
          left={menu.left}
          top={menu.top}
          onSelect={(item) => {
            hideMenu();
            menu.command(item);
          }}
          onHover={(index) => {
            const current = menuRef.current;
            if (!current) return;
            const next = { ...current, index };
            menuRef.current = next;
            setMenu(next);
          }}
        />
      ) : null}
      {emojiMenu ? (
        <EmojiMenu
          items={emojiMenu.items}
          index={emojiMenu.index}
          left={emojiMenu.left}
          top={emojiMenu.top}
          onSelect={(item) => {
            hideEmojiMenu();
            emojiMenu.command(item);
          }}
          onHover={(index) => {
            const current = emojiMenuRef.current;
            if (!current) return;
            const next = { ...current, index };
            emojiMenuRef.current = next;
            setEmojiMenu(next);
          }}
        />
      ) : null}
      {emojiPicker && editor ? (
        <div
          ref={emojiPickerRef}
          className="editor-emoji-popover"
          style={{ left: emojiPicker.left, top: emojiPicker.top }}
        >
          <EmojiPicker
            label={t("emoji.insert")}
            testId="editor-emoji-picker"
            onSelect={(emoji) => {
              const pos = Math.min(emojiPicker.pos, editor.state.doc.content.size);
              setEmojiPicker(null);
              // The picker already records the emoji as recent.
              editor.chain().focus().insertContentAt(pos, emoji).run();
            }}
            onClose={() => {
              setEmojiPicker(null);
              editor.commands.focus();
            }}
          />
        </div>
      ) : null}
      {linkMenu ? (
        <LinkMenu
          items={linkMenu.items}
          index={linkMenu.index}
          left={linkMenu.left}
          top={linkMenu.top}
          onSelect={(item) => {
            hideLinkMenu();
            linkMenu.command(item);
          }}
          onHover={(index) => {
            const current = linkMenuRef.current;
            if (!current) return;
            const next = { ...current, index };
            linkMenuRef.current = next;
            setLinkMenu(next);
          }}
        />
      ) : null}
    </div>
  );
}
