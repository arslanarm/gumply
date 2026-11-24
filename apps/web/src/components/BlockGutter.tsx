import type { Editor as TipTapEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  moveBlockTo,
  moveBlockConverting,
  type BlockRef,
} from "../lib/blocks.js";
import { insertBlockBelow, TURN_INTO, turnInto } from "../editor/block-editing.js";
import { setCalloutFold } from "../editor/callout/callout.js";
import { dropBeside } from "../editor/columns/commands.js";
import { t, useT } from "../i18n/index.js";
import { copyBlockLink } from "../editor/page-embed/block-ids.js";

interface HoverState {
  block: BlockRef;
  left: number;
  top: number;
}

interface MenuState extends HoverState {
  menuLeft: number;
  menuTop: number;
  /** The block's own extent: the menu opens below or above it, never over it. */
  blockTop: number;
  blockBottom: number;
  maxHeight?: number;
  placed: boolean;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

interface DropState {
  left: number;
  top: number;
  width: number;
  targetPos: number;
  /** #2kafk39m: nothing can be dropped here (no line; the cursor says so). */
  illegal?: boolean;
  /** spec/columns: dropped on a block's side edge, beside it (a vertical guide). */
  side?: { target: BlockRef; side: "left" | "right"; height: number };
}

/** How close to a block's left or right edge a drop counts as "beside it" (spec/columns). */
const SIDE_ZONE = 48;

export interface BlockGutterProps {
  editor: TipTapEditor;
}

/** A block's element sits directly in the editor or in a column (spec/columns). */
const isBlockParent = (view: EditorView, element: Element | null) =>
  element === view.dom || (element instanceof HTMLElement && element.classList.contains("md-column"));

/**
 * #e9bd64bb (#n6cy66ib): the position under the pointer. Over a block atom (an
 * image, an embed, a divider) `pos` can land just after it; `inside` is the
 * atom itself, so use the position right before it.
 */
function pointedPos(doc: ProseMirrorNode, found: { pos: number; inside: number }): number {
  if (found.inside >= 0) {
    const node = doc.nodeAt(found.inside);
    if (node && node.isBlock && node.isAtom) return found.inside;
  }
  return found.pos;
}

function domForBlock(view: EditorView, block: BlockRef): HTMLElement | null {
  try {
    const direct = view.nodeDOM(block.from);
    if (direct instanceof HTMLElement && isBlockParent(view, direct.parentElement)) return direct;
  } catch {
    // Fall through to the DOM-at-position walk.
  }

  try {
    const at = view.domAtPos(block.from + 1);
    let element = at.node.nodeType === Node.ELEMENT_NODE ? (at.node as Element) : at.node.parentElement;
    if (!element) return null;

    const item = element.closest("li");
    if (item && view.dom.contains(item)) return item as HTMLElement;

    while (element.parentElement && !isBlockParent(view, element.parentElement)) {
      element = element.parentElement;
    }
    return element === view.dom ? null : (element as HTMLElement);
  } catch {
    return null;
  }
}

/** Width of the margin left of the text that still counts as hovering. */
const GUTTER_ZONE = 72;
const GUTTER_HEIGHT = 26;

/** Offset that centres the gutter on the block's first line of text. */
function firstLineOffset(dom: HTMLElement): number {
  const style = window.getComputedStyle(dom);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  return Math.max(0, borderTop + paddingTop + (lineHeight - GUTTER_HEIGHT) / 2);
}

/**
 * The editor column plus the left margin where the gutter sits: where the
 * pointer hovers a block, and where a dragged block can be dropped.
 */
function inBlockZone(host: HTMLElement, x: number, y: number): boolean {
  const rect = host.getBoundingClientRect();
  return y >= rect.top && y <= rect.bottom && x >= rect.left - GUTTER_ZONE && x <= rect.right + 24;
}

function inRect(rect: DOMRect, x: number, y: number, pad = 6): boolean {
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}

/** Hover gutter + block menu for the top-level block or list item under the pointer. */
export function BlockGutter({ editor }: BlockGutterProps) {
  useT();
  const [hover, setHover] = useState<HoverState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [dragging, setDragging] = useState<BlockRef | null>(null);

  const hoverRef = useRef<HoverState | null>(null);
  hoverRef.current = hover;
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;
  const draggingRef = useRef<BlockRef | null>(null);
  draggingRef.current = dragging;
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const menuElementRef = useRef<HTMLDivElement | null>(null);
  const hideOnType = useRef(false);

  const closeMenu = useCallback(() => {
    setMenu(null);
    editor.view.focus();
  }, [editor]);

  useEffect(() => {
    const host = editor.view.dom.closest(".editor-host");
    if (!(host instanceof HTMLElement)) return;

    const onMove = (event: MouseEvent) => {
      if (hideOnType.current) hideOnType.current = false;
      if (draggingRef.current) return;

      const current = hoverRef.current;
      if (gutterRef.current && current) {
        if (inRect(gutterRef.current.getBoundingClientRect(), event.clientX, event.clientY)) return;
      }
      if (menuRef.current && menuElementRef.current) {
        if (inRect(menuElementRef.current.getBoundingClientRect(), event.clientX, event.clientY, 0)) return;
      }

      const clear = () => {
        if (!menuRef.current && hoverRef.current) setHover(null);
      };

      // Pointer over something else (sidebar, a menu, a dialog): no gutter.
      // The editor itself or the empty page margin around it (an ancestor of
      // the editor) both count, like Notion.
      const target = event.target instanceof Node ? event.target : null;
      if (!target || !(host.contains(target) || target.contains(host))) {
        clear();
        return;
      }

      // Hover zone = the editor column plus the left margin where the gutter
      // sits, so moving from the text to `+`/`⋮⋮` never drops the gutter.
      if (!inBlockZone(host, event.clientX, event.clientY)) {
        clear();
        return;
      }

      const editorRect = editor.view.dom.getBoundingClientRect();
      const left = Math.min(Math.max(event.clientX, editorRect.left + 4), editorRect.right - 4);
      const found = editor.view.posAtCoords({ left, top: event.clientY });
      if (!found) return;

      const block = blockAt(editor.state.doc, pointedPos(editor.state.doc, found));
      const dom = block ? domForBlock(editor.view, block) : null;
      if (!block || !dom) {
        clear();
        return;
      }
      const rect = dom.getBoundingClientRect();
      const next: HoverState = {
        block,
        left: Math.max(6, rect.left - 54),
        top: rect.top + firstLineOffset(dom),
      };
      if (
        current &&
        current.block.from === next.block.from &&
        current.block.node === next.block.node &&
        current.left === next.left &&
        current.top === next.top
      ) {
        return;
      }
      setHover(next);
    };

    const onLeave = () => {
      if (menuRef.current) return;
      setHover(null);
    };
    const onHide = () => setHover(null);
    const onUpdate = () => {
      hideOnType.current = true;
      setHover(null);
      if (!draggingRef.current) setMenu(null);
    };

    /**
     * #5634v3df: an image block dragged by the image itself moves like its ⋮⋮
     * (a decision: one undo step, no copy). ProseMirror's own node drag is
     * not used; inline images keep ⋮⋮ only.
     */
    const onDragStart = (event: DragEvent) => {
      if (draggingRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      const nodeView = target?.closest(".node-image");
      if (!nodeView || !editor.view.dom.contains(nodeView) || !editor.isEditable) return;
      let block: BlockRef | null = null;
      try {
        block = blockAt(editor.state.doc, editor.view.posAtDOM(nodeView, 0));
      } catch {
        block = null;
      }
      if (!block || block.node.type.name !== "image" || !event.dataTransfer) return;
      // Before ProseMirror's dragstart (bubble phase on the editor).
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-gumply-block", "1");
      draggingRef.current = block;
      setDragging(block);
      setHover(null);
      setMenu(null);
    };

    /**
     * #5634v3df: listened for on the whole document. Dragging ⋮⋮ straight up
     * or down keeps the pointer in the gutter, outside the editor host, and a
     * drop there used to be refused, so nothing moved.
     */
    const onDragOver = (event: DragEvent) => {
      const source = draggingRef.current;
      if (!source) return;
      if (!inBlockZone(host, event.clientX, event.clientY)) {
        dropRef.current = null;
        setDrop(null);
        return;
      }
      // Capture phase: stop ProseMirror's own drop handler from inserting the
      // dragged data as text as well as moving the block.
      event.preventDefault();
      event.stopPropagation();
      const next = computeDrop(event, source);
      if (event.dataTransfer) event.dataTransfer.dropEffect = next?.illegal ? "none" : "move";
      dropRef.current = next;
      setDrop(next?.illegal ? null : next);
    };
    const onDrop = (event: DragEvent) => {
      const source = draggingRef.current;
      const target = dropRef.current;
      if (!source) return;
      event.preventDefault();
      event.stopPropagation();
      draggingRef.current = null;
      dropRef.current = null;
      setDragging(null);
      setDrop(null);
      if (!target || target.illegal) return;
      const tr = target.side
        ? dropBeside(editor.state, source, target.side.target, target.side.side)
        : (moveBlockTo(editor.state, source, target.targetPos) ?? moveBlockConverting(editor.state, source, target.targetPos));
      if (tr) {
        editor.view.dispatch(tr);
        editor.view.focus();
      }
    };
    const onDragEnd = () => {
      draggingRef.current = null;
      dropRef.current = null;
      setDragging(null);
      setDrop(null);
    };

    document.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    host.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("dragend", onDragEnd, true);
    document.addEventListener("scroll", onHide, true);
    window.addEventListener("resize", onHide);
    editor.on("update", onUpdate);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      host.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragend", onDragEnd, true);
      document.removeEventListener("scroll", onHide, true);
      window.removeEventListener("resize", onHide);
      editor.off("update", onUpdate);
    };
  }, [editor]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuElementRef.current?.contains(target)) return;
      if (gutterRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        editor.view.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, editor]);

  // Like Notion: the menu opens under the block it acts on (aligned with the
  // handle) and flips above it when there's no room below (#smwaixfp).
  const openMenu = (state: HoverState) => {
    const dom = domForBlock(editor.view, state.block);
    const rect = dom?.getBoundingClientRect();
    const blockTop = rect?.top ?? state.top;
    const blockBottom = rect?.bottom ?? state.top + 26;
    setMenu({
      ...state,
      menuLeft: Math.max(VIEWPORT_MARGIN, Math.min(state.left, window.innerWidth - 244)),
      menuTop: blockBottom + MENU_GAP,
      blockTop,
      blockBottom,
      placed: false,
    });
  };

  useLayoutEffect(() => {
    const element = menuElementRef.current;
    if (!menu || menu.placed || !element) return;
    const height = element.scrollHeight;
    const below = window.innerHeight - VIEWPORT_MARGIN - (menu.blockBottom + MENU_GAP);
    const above = menu.blockTop - MENU_GAP - VIEWPORT_MARGIN;
    let menuTop = menu.blockBottom + MENU_GAP;
    let maxHeight: number | undefined;
    if (height > below) {
      if (height <= above) {
        menuTop = menu.blockTop - MENU_GAP - height;
      } else if (above > below) {
        maxHeight = above;
        menuTop = VIEWPORT_MARGIN;
      } else {
        maxHeight = below;
      }
    }
    setMenu({ ...menu, menuTop, maxHeight, placed: true });
  }, [menu]);

  const run = (action: (block: BlockRef) => void) => {
    const current = menuRef.current;
    if (!current) return;
    // Inside the block, or right before it for an atom (an image has no inside).
    const block = blockAt(editor.state.doc, current.block.node.isAtom ? current.block.from : current.block.from + 1);
    setMenu(null);
    if (block) action(block);
    editor.view.focus();
  };

  const move = (block: BlockRef, direction: "up" | "down") => {
    const tr = moveBlock(editor.state, block, direction);
    if (tr) editor.view.dispatch(tr);
  };

  // ---------- drag & drop ----------
  const dropRef = useRef<DropState | null>(null);
  dropRef.current = drop;

  const computeDrop = (event: DragEvent, source: BlockRef): DropState | null => {
    const target = event.target as Element | null;
    if (target?.closest(".block-gutter") || target?.closest(".block-menu")) return null;

    const editorRect = editor.view.dom.getBoundingClientRect();
    const left = Math.min(Math.max(event.clientX, editorRect.left + 4), editorRect.right - 4);
    const found = editor.view.posAtCoords({ left, top: event.clientY });
    if (!found) return null;
    const block = blockAt(editor.state.doc, pointedPos(editor.state.doc, found));
    if (!block) return null;

    const sourceIsItem = source.node.type.name === "listItem" || source.node.type.name === "taskItem";
    const targetIsItem = block.node.type.name === "listItem" || block.node.type.name === "taskItem";
    // #2kafk39m: an item dropped among blocks, or a paragraph among items, is converted (see
    // moveBlockConverting); a spot where neither works shows no line and refuses the drop.

    const dom = domForBlock(editor.view, block);
    if (!dom) return null;
    const rect = dom.getBoundingClientRect();
    // spec/columns: near a block's left or right edge, the drop goes beside it.
    if (!sourceIsItem && !targetIsItem) {
      // #5634v3df: left of the block (the gutter, where ⋮⋮ is dragged straight
      // up or down) is between blocks, not beside one.
      const side =
        event.clientX < rect.left
          ? null
          : event.clientX < rect.left + 12
            ? "left"
            : event.clientX > rect.right - SIDE_ZONE
              ? "right"
              : null;
      if (side && dropBeside(editor.state, source, block, side)) {
        return {
          left: side === "left" ? rect.left - 8 : rect.right + 5,
          top: rect.top,
          width: 3,
          targetPos: -1,
          side: { target: block, side, height: rect.height },
        };
      }
    }
    const before = event.clientY < rect.top + rect.height / 2;
    const targetPos = before ? block.from : block.to;
    if (targetPos === source.from || targetPos === source.to) return null;
    const legal =
      moveBlockTo(editor.state, source, targetPos) !== null || moveBlockConverting(editor.state, source, targetPos) !== null;
    return {
      illegal: legal ? undefined : true,
      left: rect.left,
      width: rect.width,
      top: before ? rect.top - 1 : rect.bottom - 1,
      targetPos,
    };
  };

  return (
    <>
      {hover ? (
        <div
          ref={gutterRef}
          className="block-gutter"
          data-testid="block-gutter"
          style={{ left: hover.left, top: hover.top }}
        >
          <button
            type="button"
            className="block-gutter-button"
            data-testid="block-insert"
            aria-label={t("blocks.insertBelow")}
            title={t("blocks.insertBelow")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertBlockBelow(editor, hover.block)}
          >
            +
          </button>
          <button
            type="button"
            className="block-gutter-button block-gutter-handle"
            data-testid="block-handle"
            aria-label={t("blocks.actions")}
            aria-haspopup="menu"
            title={t("blocks.handleHint")}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-gumply-block", "1");
              draggingRef.current = hover.block;
              setDragging(hover.block);
              setMenu(null);
            }}
            onClick={() => {
              if (draggingRef.current) return;
              openMenu(hover);
            }}
          >
            ⋮⋮
          </button>
        </div>
      ) : null}

      {drop ? (
        <div
          className={`block-drop-indicator${drop.side ? " is-side" : ""}`}
          data-testid="block-drop-indicator"
          data-side={drop.side?.side}
          style={{ left: drop.left, top: drop.top, width: drop.width, height: drop.side ? drop.side.height : undefined }}
        />
      ) : null}

      {menu ? (
        <div
          ref={menuElementRef}
          className="block-menu"
          role="menu"
          aria-label={t("blocks.actions")}
          data-testid="block-menu"
          style={{
            left: menu.menuLeft,
            top: menu.menuTop,
            maxHeight: menu.maxHeight,
            visibility: menu.placed ? "visible" : "hidden",
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="block-menu-item"
            data-testid="block-menu-item-copy-block-link"
            onClick={() => run((block) => copyBlockLink(editor, block, false))}
          >
            {t("blocks.copyLink")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu-item"
            data-testid="block-menu-item-copy-block-embed"
            onClick={() => run((block) => copyBlockLink(editor, block, true))}
          >
            {t("blocks.copyEmbed")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu-item"
            data-testid="block-menu-item-duplicate"
            onClick={() => run((block) => {
              const tr = duplicateBlock(editor.state, block);
              if (tr) editor.view.dispatch(tr);
            })}
          >
            {t("blocks.duplicate")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu-item"
            data-testid="block-menu-item-move-up"
            onClick={() => run((block) => move(block, "up"))}
          >
            {t("blocks.moveUp")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu-item"
            data-testid="block-menu-item-move-down"
            onClick={() => run((block) => move(block, "down"))}
          >
            {t("blocks.moveDown")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu-item is-danger"
            data-testid="block-menu-item-delete"
            onClick={() => run((block) => {
              const tr = deleteBlock(editor.state, block);
              if (tr) editor.view.dispatch(tr);
            })}
          >
            {t("common.delete")}
          </button>
          {menu.block.node.type.name === "callout" ? (
            <>
              <div className="block-menu-separator" />
              <p className="block-menu-heading">{t("blocks.toggleHeading")}</p>
              {menu.block.node.attrs.fold ? (
                <>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={menu.block.node.attrs.fold === "-"}
                    className="block-menu-item"
                    data-testid="block-menu-item-start-closed"
                    onClick={() => run((block) =>
                      setCalloutFold(editor.view, block.from, block.node.attrs.fold === "-" ? "+" : "-"),
                    )}
                  >
                    {menu.block.node.attrs.fold === "-" ? t("blocks.startOpen") : t("blocks.startClosed")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="block-menu-item"
                    data-testid="block-menu-item-not-toggle"
                    onClick={() => run((block) => setCalloutFold(editor.view, block.from, ""))}
                  >
                    {t("blocks.alwaysShow")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="block-menu-item"
                  data-testid="block-menu-item-make-toggle"
                  onClick={() => run((block) => setCalloutFold(editor.view, block.from, "+"))}
                >
                  {t("blocks.makeFoldable")}
                </button>
              )}
            </>
          ) : null}
          {menu.block.node.type.name === "table" || menu.block.node.type.name === "callout" ? null : (
            <>
          <div className="block-menu-separator" />
          <p className="block-menu-heading">{t("blocks.turnIntoHeading")}</p>
          {TURN_INTO.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              className="block-menu-item"
              data-testid={`block-turn-into-${item.kind}`}
              onClick={() => run((block) => turnInto(editor, block, item.kind))}
            >
              {item.label}
            </button>
          ))}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
