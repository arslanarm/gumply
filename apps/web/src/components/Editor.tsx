import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor, type Editor as TipTapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { Page, PageMeta } from "@gumply/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { api } from "../api/client.js";
import { LinkMenu } from "./LinkMenu.js";
import { SlashMenu } from "./SlashMenu.js";
import { Autosave, type SaveState } from "../editor/autosave.js";
import { createSlashExtension, type SlashHandlers } from "../editor/slash-extension.js";
import type { SlashItem } from "../editor/slash-items.js";
import { setWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { WikiLink } from "../editor/wikilink/node.js";
import {
  createWikiLinkExtension,
  type LinkMenuHandlers,
} from "../editor/wikilink/suggestion-extension.js";
import type { LinkSuggestion } from "../lib/wikilinks.js";
import { normalizeEditorMarkdown } from "../lib/markdown.js";
import { taskCheckboxLabel } from "../lib/task.js";

export interface EditorControls {
  flush: () => Promise<void>;
  focusBody: () => void;
}

export interface EditorProps {
  page: Page;
  pages: readonly PageMeta[];
  onSaveState: (state: SaveState) => void;
  onReady?: (controls: EditorControls) => void;
  onOpenLink: (link: { targetTitle: string; heading: string }) => void;
  onCreateLink: (title: string) => void;
  headingToReveal?: string | null;
  onHeadingResult?: (found: boolean) => void;
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
  onReady,
  onOpenLink,
  onCreateLink,
  headingToReveal,
  onHeadingResult,
}: EditorProps) {
  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<SlashMenuState | null>(null);
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const linkMenuRef = useRef<LinkMenuState | null>(null);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;
  const onHeadingResultRef = useRef(onHeadingResult);
  onHeadingResultRef.current = onHeadingResult;

  const autosave = useMemo(() => {
    const instance = new Autosave({
      save: async (content) => {
        await api.updatePage(page.id, { content });
      },
      onState: (state) => onSaveStateRef.current(state),
    });
    instance.reset(page.content);
    return instance;
    // page.id is stable while this component is mounted (it is keyed by id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Node views read page resolution from this store.
  useEffect(() => {
    setWikiLinkEnvironment({ pages, openLink: onOpenLink, createLink: onCreateLink });
  }, [pages, onOpenLink, onCreateLink]);

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

  // ---------- editor ----------

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({
        nested: true,
        a11y: {
          checkboxLabel: (node, checked) => taskCheckboxLabel(node.textContent, checked),
        },
      }),
      Placeholder.configure({ placeholder: "Type '/' for commands, '[[' to link a page" }),
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
    ],
    content: page.content,
    editorProps: {
      attributes: {
        class: "gumply-editor",
        "aria-label": "Page content",
        "data-testid": "editor-content",
      },
    },
    onUpdate: ({ editor: instance }) => {
      autosave.schedule(readMarkdown(instance));
    },
  });

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
      focusBody: () => editor.commands.focus("start"),
    });
  }, [editor, autosave, onReady]);

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
      <EditorContent editor={editor} />
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
