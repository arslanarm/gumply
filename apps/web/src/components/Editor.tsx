import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor, type Editor as TipTapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { Page } from "@gumply/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { api } from "../api/client.js";
import { SlashMenu } from "./SlashMenu.js";
import { Autosave, type SaveState } from "../editor/autosave.js";
import { createSlashExtension, type SlashHandlers } from "../editor/slash-extension.js";
import type { SlashItem } from "../editor/slash-items.js";
import { normalizeEditorMarkdown } from "../lib/markdown.js";
import { taskCheckboxLabel } from "../lib/task.js";

export interface EditorControls {
  flush: () => Promise<void>;
  focusBody: () => void;
}

export interface EditorProps {
  page: Page;
  onSaveState: (state: SaveState) => void;
  onReady?: (controls: EditorControls) => void;
}

interface MenuState {
  items: SlashItem[];
  index: number;
  left: number;
  top: number;
  command: (item: SlashItem) => void;
}

interface MarkdownStorage {
  markdown?: { getMarkdown?: () => string };
}

function readMarkdown(editor: TipTapEditor): string {
  const storage = editor.storage as unknown as MarkdownStorage;
  return normalizeEditorMarkdown(storage.markdown?.getMarkdown?.() ?? "");
}

/** TipTap block editor with `/` menu and debounced autosave. */
export function Editor({ page, onSaveState, onReady }: EditorProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;

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

  const showMenu = (props: SuggestionProps<SlashItem>) => {
    const rect = props.clientRect?.() ?? null;
    const next: MenuState = {
      items: props.items,
      index: 0,
      left: rect?.left ?? 0,
      top: (rect?.bottom ?? 0) + 6,
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
      slashExtension,
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
    </div>
  );
}
