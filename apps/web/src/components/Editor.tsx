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
import { Autosave, type SaveState } from "../editor/autosave.js";
import {
  findUploadNode,
  finishUpload,
  insertUploadPlaceholder,
  removeUpload,
} from "../editor/attachments/insert.js";
import { ImageBlock, FileAttachment } from "../editor/attachments/nodes.js";
import { setAttachmentPicker } from "../editor/attachments/store.js";
import { BlockEditing } from "../editor/block-editing.js";
import { NotionCodeBlock } from "../editor/code-block.js";
import { pastedTablesToMarkdown } from "../editor/paste-table.js";
import { EmptyLineParagraph } from "../editor/empty-lines.js";
import { createEmojiExtension, type EmojiHandlers } from "../editor/emoji/extension.js";
import { setEmojiPickerOpener } from "../editor/emoji/store.js";
import type { EmojiEntry } from "../lib/emoji/data.js";
import { MarkdownLink } from "../editor/link.js";
import {
  MarkdownHeading,
  MarkdownHorizontalRule,
  MarkdownMarkup,
  MarkdownOrderedList,
} from "../editor/raw-markdown/markup.js";
import { RawBlock, RawInline } from "../editor/raw-markdown/nodes.js";
import { MarkdownHardBreak, MarkdownText } from "../editor/raw-markdown/text.js";
import { MarkdownBulletList, MarkdownTaskList, setListStyle } from "../editor/raw-markdown/list-style.js";
import { MarkdownTaskListFix, TaskListTight } from "../editor/markdown-task-list-fix.js";
import { ShortcutHistory } from "../editor/shortcut-history.js";
import { createSlashExtension, type SlashHandlers } from "../editor/slash-extension.js";
import type { SlashItem } from "../editor/slash-items.js";
import { AccessibleTaskItem } from "../editor/task-item.js";
import { TaskShortcut } from "../editor/task-shortcut.js";
import { setWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
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
  const onExitTopRef = useRef(onExitTop);
  onExitTopRef.current = onExitTop;
  const exitTopExtension = useMemo(() => createExitTopExtension(onExitTopRef), []);
  const versionRef = useRef(page.updated);
  // D20: a rename changes the id while this editor stays mounted; always save
  // to the current one.
  const pageIdRef = useRef(page.id);
  pageIdRef.current = page.id;
  const forceRef = useRef(false);

  // A rename/reload from App updates the version this editor must send.
  useEffect(() => {
    versionRef.current = page.updated;
  }, [page.updated]);

  const autosave = useMemo(() => {
    const instance = new Autosave({
      save: async (content) => {
        const force = forceRef.current;
        try {
          const savedId = pageIdRef.current;
          const updated = await api.updatePage(savedId, {
            content,
            expectedUpdated: versionRef.current,
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
      openLink: onOpenLink,
      createLink: onCreateLink,
    });
  }, [page.id, pages, attachments, onOpenLink, onCreateLink]);

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
      }),
      NotionCodeBlock,
      MarkdownBulletList,
      MarkdownHeading.configure({ levels: [1, 2, 3] }),
      MarkdownOrderedList,
      MarkdownHorizontalRule,
      MarkdownMarkup,
      EmptyLineParagraph,
      MarkdownText,
      MarkdownHardBreak,
      RawBlock,
      RawInline,
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
        "aria-label": "Page content",
        "data-testid": "editor-content",
      },
      // Pasted HTML tables become a GFM table block (#y5iqswjf).
      transformPastedHTML: (html) => pastedTablesToMarkdown(html),
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
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
    },
    onUpdate: ({ editor: instance }) => {
      autosave.schedule(readMarkdown(instance));
    },
  });

  editorRef.current = editor;

  useEffect(() => {
    return () => {
      autosave.dispose();
    };
  }, [autosave]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void autosave.flush();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [autosave]);

  useEffect(() => {
    if (!editor) return;
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
    });
  }, [editor, autosave, onReady, page.id]);

  // `[[Page#Heading]]`: scroll to the heading, or report it missing.
  useEffect(() => {
    if (!editor || !headingToReveal) return;

    const wanted = headingToReveal.trim().toLowerCase();
    let headingPos: number | null = null;

    editor.state.doc.descendants((node, pos) => {
      if (headingPos !== null) return false;
      if (node.type.name === "heading" && node.textContent.trim().toLowerCase() === wanted) {
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
    <div className="editor-host">
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
      {editor ? <BlockGutter editor={editor} /> : null}
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
            label="Insert emoji"
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
