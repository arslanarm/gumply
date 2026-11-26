/**
 * Right-click in the editor (#bg3cb83t): a menu at the pointer with what
 * applies where you clicked.
 *
 * - **Text:** Cut, Copy, Paste, Paste as plain text; with a selection,
 *   formatting, Colour (#h368c8ni) and Link; Turn into, Duplicate block and Delete block; on a
 *   heading, Copy link to heading (`[[Page#Heading]]`).
 * - **Code blocks and tables:** only the clipboard and what applies there.
 * - **Links:** Open, Copy link, Edit link, Remove link. **Wiki links:** Open,
 *   Copy link. **Images:** Open, Copy, Delete.
 *
 * Shift+right-click (and right-clicks on inputs inside the editor, like a
 * raw block's source) keep the browser's own menu, for spellcheck and dev
 * tools. The context-menu key and Shift+F10 open it at the caret, with the
 * first item focused; arrows move, Escape returns to the text.
 */
import { formatWikilink } from "@gumply/core";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { blockAt, deleteBlock, duplicateBlock } from "../lib/blocks.js";
import { copyBlockLink } from "../editor/page-embed/block-ids.js";
import { t } from "../i18n/index.js";
import { TURN_INTO, turnInto } from "../editor/block-editing.js";
import { canFormat, markActions, openLinkField, removeLink, toggleMark } from "../editor/formatting.js";
import { getWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { currentModifierLabel, withModifier } from "../lib/shortcuts.js";
import { Icon, type IconName } from "./Icon.js";
import { ColorPalette } from "./ColorPalette.js";

export interface EditorContextMenuProps {
  editor: Editor;
  /** Show a short notice (e.g. the clipboard was blocked). */
  onNotice?: (message: string) => void;
}

type Context =
  | { kind: "text" }
  | { kind: "code" }
  | { kind: "table" }
  | { kind: "link"; href: string }
  | { kind: "wiki"; targetTitle: string; alias: string; heading: string }
  | { kind: "image"; pos: number; url: string };

interface MenuState {
  x: number;
  y: number;
  context: Context;
  /** A heading under the pointer: its text (for Copy link to heading). */
  heading: string | null;
  focusFirst: boolean;
}

interface Item {
  id: string;
  label: string;
  icon?: IconName;
  keys?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

type Section = Item[];

const clipboardReadable = () => typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";
const clipboardRichReadable = () => typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";
const clipboardWritable = () => typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";

function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

export function EditorContextMenu({ editor, onNotice }: EditorContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [submenu, setSubmenu] = useState<null | "turn-into" | "color">(null);
  /** The submenu was opened from the keyboard: focus its first item. */
  const [submenuFocus, setSubmenuFocus] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Open on right-click / the context-menu key inside the text.
  useEffect(() => {
    const dom = editor.view.dom;

    const contextAt = (target: Element | null, pos: number): Omit<MenuState, "x" | "y" | "focusFirst"> => {
      const view = editor.view;
      const state = editor.state;
      const anchor = target?.closest("a[href]");
      if (anchor && dom.contains(anchor)) {
        return { context: { kind: "link", href: anchor.getAttribute("href") ?? "" }, heading: null };
      }
      const wiki = target?.closest(".wiki-link");
      if (wiki && dom.contains(wiki)) {
        const at = view.posAtDOM(wiki, 0);
        const node = state.doc.nodeAt(at) ?? state.doc.nodeAt(Math.max(0, at - 1));
        if (node?.type.name === "wikiLink") {
          return {
            context: {
              kind: "wiki",
              targetTitle: String(node.attrs.targetTitle ?? ""),
              alias: String(node.attrs.alias ?? ""),
              heading: String(node.attrs.heading ?? ""),
            },
            heading: null,
          };
        }
      }
      const image = target?.closest("img");
      if (image && dom.contains(image)) {
        const at = view.posAtDOM(image, 0);
        const imagePos = [at, at - 1].find((candidate) => state.doc.nodeAt(candidate)?.type.name === "image") ?? at;
        return { context: { kind: "image", pos: imagePos, url: (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src }, heading: null };
      }
      const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
      let inTable = false;
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const name = $pos.node(depth).type.name;
        if (name === "table") inTable = true;
      }
      if ($pos.parent.type.spec.code) return { context: { kind: "code" }, heading: null };
      if (inTable) return { context: { kind: "table" }, heading: null };
      const heading = $pos.parent.type.name === "heading" ? $pos.parent.textContent.trim() || null : null;
      return { context: { kind: "text" }, heading };
    };

    const onContextMenu = (event: MouseEvent) => {
      if (event.shiftKey) return;
      const target = event.target as Element | null;
      // The browser's menu stays on inputs (raw-block source, code language search).
      if (target?.closest("input, textarea, select, .raw-block-editor")) return;
      const view = editor.view;
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!at) return;
      event.preventDefault();
      const { from, to } = view.state.selection;
      const onImage = target?.closest("img");
      // Right-click outside the selection moves the caret there, like a text editor.
      if (!onImage && (at.pos < from || at.pos > to || from === to)) {
        try {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
        } catch {
          // Leave the selection alone.
        }
      }
      if (onImage && at.inside >= 0) {
        try {
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.inside)));
        } catch {
          // Not selectable; the menu still acts on the image position.
        }
      }
      setSubmenu(null);
      setMenu({ x: event.clientX, y: event.clientY, focusFirst: false, ...contextAt(target, at.pos) });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
      event.preventDefault();
      const view = editor.view;
      const coords = view.coordsAtPos(view.state.selection.head);
      const domAt = view.domAtPos(view.state.selection.head);
      const element = domAt.node instanceof Element ? domAt.node : domAt.node.parentElement;
      setSubmenu(null);
      setMenu({ x: coords.left, y: coords.bottom + 4, focusFirst: true, ...contextAt(element, view.state.selection.head) });
    };

    dom.addEventListener("contextmenu", onContextMenu);
    dom.addEventListener("keydown", onKeyDown);
    return () => {
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("keydown", onKeyDown);
    };
  }, [editor]);

  // Close on outside press, scroll or resize; keyboard handling inside.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  // Keep it on screen, and focus it (the first item from the keyboard).
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !menu) return;
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8));
    const top = menu.y + element.offsetHeight > window.innerHeight - 8 ? Math.max(8, menu.y - element.offsetHeight) : menu.y;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    if (menu.focusFirst) element.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    else element.focus({ preventScroll: true });
  }, [menu]);

  if (!menu) return null;

  const done = () => {
    setMenu(null);
    setSubmenu(null);
  };
  const back = () => {
    done();
    editor.commands.focus();
  };

  const toggleSubmenu = (which: "turn-into" | "color", fromKeyboard = false) => {
    setSubmenuFocus(fromKeyboard);
    setSubmenu((open) => (open === which ? null : which));
    if (fromKeyboard && which === "turn-into") {
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.context-submenu [role="menuitem"]')?.focus());
    }
  };

  /** Run a document command with the text focused (and its DOM selection back). */
  const inText = (action: () => void) => () => {
    done();
    editor.view.focus();
    action();
  };

  const notice = (message: string) => onNotice?.(message) ?? getWikiLinkEnvironment().reportError?.(message);

  const clipboard: Section = [];
  const hasSelection = !editor.state.selection.empty;
  if (menu.context.kind !== "image") {
    if (hasSelection) {
      clipboard.push({ id: "cut", label: t("editorMenu.cut"), icon: "scissors", keys: withModifier(currentModifierLabel(), "X"), run: inText(() => document.execCommand("cut")) });
      clipboard.push({ id: "copy", label: t("editorMenu.copy"), icon: "copy", keys: withModifier(currentModifierLabel(), "C"), run: inText(() => document.execCommand("copy")) });
    }
    if (clipboardReadable()) {
      clipboard.push({
        id: "paste",
        label: t("editorMenu.paste"),
        icon: "clipboard",
        keys: withModifier(currentModifierLabel(), "V"),
        run: async () => {
          done();
          editor.view.focus();
          try {
            if (clipboardRichReadable()) {
              const items = await navigator.clipboard.read();
              const html = items.find((item) => item.types.includes("text/html"));
              if (html) {
                const text = await (await html.getType("text/html")).text();
                if (editor.view.pasteHTML(text)) return;
              }
            }
            editor.view.pasteText(await navigator.clipboard.readText());
          } catch {
            notice(t("editorMenu.pasteBlocked", { keys: withModifier(currentModifierLabel(), "V") }));
          }
        },
      });
      clipboard.push({
        id: "paste-plain",
        label: t("editorMenu.pastePlain"),
        keys: `${currentModifierLabel()}+Shift+V`,
        run: async () => {
          done();
          editor.view.focus();
          try {
            const text = await navigator.clipboard.readText();
            // Plain: inserted as typed text, never parsed as Markdown or HTML.
            editor.view.dispatch(editor.state.tr.insertText(text));
          } catch {
            notice(t("editorMenu.pasteBlocked", { keys: `${currentModifierLabel()}+Shift+V` }));
          }
        },
      });
    }
  }

  const sections: Section[] = [];
  const context = menu.context;

  if (context.kind === "link") {
    const href = safeHref(context.href);
    sections.push([
      ...(href ? [{ id: "open-link", label: t("editorMenu.openLink"), icon: "externalLink" as const, run: () => { done(); window.open(href, "_blank", "noopener,noreferrer"); } }] : []),
      ...(clipboardWritable()
        ? [{ id: "copy-link", label: t("editorMenu.copyLink"), icon: "copy" as const, run: () => { done(); void navigator.clipboard.writeText(context.href); } }]
        : []),
      {
        id: "edit-link",
        label: t("editorMenu.editLink"),
        icon: "pencil",
        run: inText(() => {
          editor.chain().focus().extendMarkRange("link").run();
          openLinkField();
        }),
      },
      { id: "remove-link", label: t("editorMenu.removeLink"), icon: "unlink", run: inText(() => removeLink(editor)) },
    ]);
  } else if (context.kind === "wiki") {
    const raw = `[[${context.targetTitle}${context.heading ? `#${context.heading}` : ""}${context.alias ? `|${context.alias}` : ""}]]`;
    sections.push([
      { id: "open-link", label: t("editorMenu.openPage"), icon: "externalLink", run: () => { done(); getWikiLinkEnvironment().openLink({ targetTitle: context.targetTitle, heading: context.heading }); } },
      ...(clipboardWritable() ? [{ id: "copy-link", label: t("editorMenu.copyLink"), icon: "copy" as const, run: () => { done(); void navigator.clipboard.writeText(raw); } }] : []),
    ]);
  } else if (context.kind === "image") {
    const canCopyImage = typeof window !== "undefined" && "ClipboardItem" in window && typeof navigator.clipboard?.write === "function";
    sections.push([
      { id: "open-image", label: t("editorMenu.openImage"), icon: "externalLink", run: () => { done(); window.open(context.url, "_blank", "noopener,noreferrer"); } },
      ...(canCopyImage
        ? [{
            id: "copy-image",
            label: t("editorMenu.copyImage"),
            icon: "copy" as const,
            run: async () => {
              done();
              try {
                const blob = await (await fetch(context.url)).blob();
                // Browsers accept PNG on the clipboard; others are converted.
                const png = blob.type === "image/png" ? blob : await toPng(blob);
                await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
              } catch {
                notice(t("editorMenu.copyImageFailed"));
              }
            },
          }]
        : []),
      {
        id: "delete-image",
        label: t("common.delete"),
        icon: "trash",
        danger: true,
        run: inText(() => {
          const node = editor.state.doc.nodeAt(context.pos);
          if (node) editor.view.dispatch(editor.state.tr.delete(context.pos, context.pos + node.nodeSize));
        }),
      },
    ]);
  }

  if (clipboard.length > 0) sections.push(clipboard);

  const formattable = (context.kind === "text" || context.kind === "table" || context.kind === "link") && canFormat(editor);
  if (formattable) {
    sections.push([
      ...markActions().map<Item>((action) => ({
        id: `format-${action.mark}`,
        label: editor.isActive(action.mark) ? action.removeLabel : action.label,
        icon: action.icon,
        keys: action.keys,
        run: inText(() => toggleMark(editor, action.mark)),
      })),
      { id: "color", label: t("format.color"), icon: "palette", run: () => toggleSubmenu("color") },
      ...(context.kind !== "link"
        ? [{ id: "format-link", label: t("editorMenu.link"), icon: "link" as const, keys: withModifier(currentModifierLabel(), "K"), run: inText(() => { openLinkField(); }) }]
        : []),
    ]);
  }

  if (context.kind === "text" || context.kind === "code") {
    const blockItems: Section = [];
    if (context.kind === "text") {
      blockItems.push({ id: "turn-into", label: t("blocks.turnIntoHeading"), icon: "text", run: () => toggleSubmenu("turn-into") });
    }
    blockItems.push(
      {
        id: "duplicate-block",
        label: t("editorMenu.duplicateBlock"),
        icon: "copy",
        keys: withModifier(currentModifierLabel(), "D"),
        run: inText(() => {
          const block = blockAt(editor.state.doc, editor.state.selection.from);
          const tr = block ? duplicateBlock(editor.state, block) : null;
          if (tr) editor.view.dispatch(tr);
        }),
      },
      // Page previews (#5dpxwac4): link to or embed this block elsewhere.
      ...(clipboardWritable()
        ? [
            {
              id: "copy-block-link",
              label: t("blocks.copyLink"),
              icon: "link" as const,
              run: inText(() => {
                const block = blockAt(editor.state.doc, editor.state.selection.from);
                if (block) copyBlockLink(editor, block, false);
              }),
            },
            {
              id: "copy-block-embed",
              label: t("blocks.copyEmbed"),
              icon: "copy" as const,
              run: inText(() => {
                const block = blockAt(editor.state.doc, editor.state.selection.from);
                if (block) copyBlockLink(editor, block, true);
              }),
            },
          ]
        : []),
      {
        id: "delete-block",
        label: t("editorMenu.deleteBlock"),
        icon: "trash",
        danger: true,
        run: inText(() => {
          const block = blockAt(editor.state.doc, editor.state.selection.from);
          const tr = block ? deleteBlock(editor.state, block) : null;
          if (tr) editor.view.dispatch(tr);
        }),
      },
    );
    sections.push(blockItems);
  }

  if (menu.heading && clipboardWritable()) {
    const heading = menu.heading;
    sections.push([
      {
        id: "copy-heading-link",
        label: t("editorMenu.copyHeadingLink"),
        icon: "link",
        run: () => {
          done();
          const env = getWikiLinkEnvironment();
          const page = env.pages.find((item) => item.id === env.pageId);
          const link = page ? formatWikilink(page, env.pages, { heading }) : `[[#${heading}]]`;
          void navigator.clipboard.writeText(link);
        },
      },
    ]);
  }

  const visible = sections.filter((section) => section.length > 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (submenu) {
        const opener = submenu;
        setSubmenu(null);
        ref.current?.querySelector<HTMLElement>(`[data-testid="context-${opener}"]`)?.focus();
      } else back();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    // The palette moves through its own grid.
    if (submenu === "color" && ref.current?.querySelector(".context-color")?.contains(document.activeElement)) return;
    event.preventDefault();
    const scope = submenu === "turn-into" ? ref.current?.querySelector(".context-submenu") : ref.current?.querySelector(".context-main");
    const items = [...(scope?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      className="editor-context-menu"
      role="menu"
      aria-label={t("editorMenu.label")}
      tabIndex={-1}
      data-testid="editor-context-menu"
      data-context={context.kind}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      // Keep the text selection while clicking items.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="context-main">
        {visible.map((section, index) => (
          <Group key={index} first={index === 0}>
            {section.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`context-item${item.danger ? " is-danger" : ""}${submenu === item.id ? " is-open" : ""}`}
                data-testid={`context-${item.id}`}
                aria-haspopup={hasSubmenu(item.id) ? "menu" : undefined}
                aria-expanded={hasSubmenu(item.id) ? submenu === item.id : undefined}
                onClick={(event) => {
                  // Enter or Space on a submenu item opens it focused.
                  if (hasSubmenu(item.id) && event.detail === 0) toggleSubmenu(item.id, true);
                  else void item.run();
                }}
                onKeyDown={(event) => {
                  if (hasSubmenu(item.id) && event.key === "ArrowRight") {
                    event.preventDefault();
                    setSubmenu(null);
                    toggleSubmenu(item.id, true);
                  }
                }}
              >
                <span className="context-item-icon" aria-hidden="true">
                  {item.icon ? <Icon name={item.icon} size={15} /> : null}
                </span>
                <span className="context-item-label">{item.label}</span>
                {hasSubmenu(item.id) ? (
                  <Icon name="chevronRight" size={13} />
                ) : item.keys ? (
                  <span className="context-item-keys">{item.keys}</span>
                ) : null}
              </button>
            ))}
          </Group>
        ))}
      </div>
      {submenu === "color" ? (
        <div className="context-submenu context-color" data-testid="context-color-menu">
          <ColorPalette
            editor={editor}
            autoFocus={submenuFocus}
            testId="context-color-palette"
            onPick={() => {
              done();
              editor.commands.focus();
            }}
          />
        </div>
      ) : null}
      {submenu === "turn-into" ? (
        <div className="context-submenu" role="menu" aria-label={t("blocks.turnIntoHeading")} data-testid="context-turn-menu">
          {TURN_INTO.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="context-item"
              data-testid={`context-turn-${item.kind}`}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setSubmenu(null);
                  ref.current?.querySelector<HTMLElement>('[data-testid="context-turn-into"]')?.focus();
                }
              }}
              onClick={inText(() => {
                const block = blockAt(editor.state.doc, editor.state.selection.from);
                if (block) turnInto(editor, block, item.kind);
              })}
            >
              <span className="context-item-label">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function hasSubmenu(id: string): id is "turn-into" | "color" {
  return id === "turn-into" || id === "color";
}

function Group({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <>
      {first ? null : <div className="context-separator" role="separator" />}
      {children}
    </>
  );
}

/** Re-encode an image as PNG (the one type every browser's clipboard accepts). */
async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("PNG failed"))), "image/png"),
  );
}
