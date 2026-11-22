/**
 * The columns row's node view (spec/columns §3): the flex row, plus a resize
 * gutter between neighbouring columns. Dragging reflows the columns live
 * (a layout preview, #9j9cd5x4) and writes the new widths once, on release
 * (only the `width=` of the fences change); a double-click gives every column an equal share again. The
 * columns' own widths are node decorations (columnsLayout in ./commands.ts).
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { t } from "../../i18n/index.js";
import { COLUMNS_PREVIEW_META, type ColumnsPreview } from "./commands.js";

/** A resize never makes a column narrower than this share of the row (@lead). */
export const MIN_PERCENT = 15;

interface Props {
  node: PMNode;
  view: EditorView;
  getPos: () => number | undefined;
  HTMLAttributes: Record<string, string>;
}

export function columnsView({ node: initial, view, getPos }: Props): NodeView {
  let node = initial;
  const dom = document.createElement("div");
  dom.className = "md-columns-wrap";
  const content = document.createElement("div");
  content.className = "md-columns";
  content.setAttribute("data-testid", "columns");
  const gutters = document.createElement("div");
  gutters.className = "md-column-gutters";
  gutters.contentEditable = "false";
  dom.append(content, gutters);

  const columnElements = () => Array.from(content.children).filter((child): child is HTMLElement => child instanceof HTMLElement);

  /** Each column's share of the row, in percent, as it's laid out now. */
  const currentShares = (): number[] => {
    const rects = columnElements().map((element) => element.getBoundingClientRect().width);
    const total = rects.reduce((sum, width) => sum + width, 0) || 1;
    return rects.map((width) => (width / total) * 100);
  };

  const place = () => {
    const elements = columnElements();
    const box = dom.getBoundingClientRect();
    while (gutters.children.length > Math.max(0, elements.length - 1)) gutters.lastElementChild!.remove();
    while (gutters.children.length < elements.length - 1) gutters.append(makeGutter(gutters.children.length));
    for (let index = 0; index < elements.length - 1; index += 1) {
      const left = elements[index]!.getBoundingClientRect();
      const right = elements[index + 1]!.getBoundingClientRect();
      const handle = gutters.children[index] as HTMLElement;
      handle.style.left = `${(left.right + right.left) / 2 - box.left}px`;
      handle.style.top = `${Math.min(left.top, right.top) - box.top}px`;
      handle.style.height = `${Math.max(left.bottom, right.bottom) - Math.min(left.top, right.top)}px`;
    }
  };

  /** Lay the row out in `shares` without touching the document (#9j9cd5x4); `null` ends it. */
  const preview = (shares: number[] | null) => {
    const pos = getPos();
    if (pos === undefined) return;
    const value: ColumnsPreview | null = shares === null ? null : { pos, shares };
    view.dispatch(view.state.tr.setMeta(COLUMNS_PREVIEW_META, value).setMeta("addToHistory", false));
  };

  /** Writes the widths; true when the document changed (which also ends a preview). */
  const writeWidths = (shares: number[] | null): boolean => {
    const pos = getPos();
    if (pos === undefined) return false;
    const tr = view.state.tr;
    const allSet = Array.from({ length: node.childCount }, (_, index) => node.child(index).attrs.width).every((width) => typeof width === "number");
    let offset = pos + 1;
    node.forEach((column, _offset, index) => {
      const width = shares === null ? null : Math.round(shares[index]!);
      // Only columns whose width changes get a new fence; the first resize gives every column one.
      const changes = shares === null ? column.attrs.width !== null : !allSet || column.attrs.width !== width;
      if (changes) tr.setNodeMarkup(offset, undefined, { ...column.attrs, width });
      offset += column.nodeSize;
    });
    if (!tr.docChanged) return false;
    view.dispatch(tr);
    return true;
  };

  function makeGutter(index: number): HTMLElement {
    const handle = document.createElement("div");
    handle.className = "md-column-gutter";
    handle.setAttribute("data-testid", "column-gutter");
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = t("columns.resizeHint");
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      writeWidths(null);
    });
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const at = Array.from(gutters.children).indexOf(handle);
      const i = at < 0 ? index : at;
      const shares = currentShares();
      const startX = event.clientX;
      const rowWidth = content.getBoundingClientRect().width || 1;
      const pair = shares[i]! + shares[i + 1]!;
      let next = shares;
      let frame = 0;
      let previewed = false;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("is-dragging");
      const onMove = (move: PointerEvent) => {
        const delta = ((move.clientX - startX) / rowWidth) * 100;
        // Each of the two keeps at least the minimum (or half the pair, if the pair is narrower than two minimums).
        const floor = Math.min(MIN_PERCENT, pair / 2);
        const left = Math.max(floor, Math.min(pair - floor, shares[i]! + delta));
        next = shares.map((share, k) => (k === i ? left : k === i + 1 ? pair - left : share));
        // #9j9cd5x4: the columns reflow as the pointer moves (at most once a frame); the file
        // is written once, on release. The gutter follows the columns' real edges.
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          preview(next);
          previewed = true;
          place();
        });
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        handle.classList.remove("is-dragging");
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        const wrote = next !== shares && writeWidths(next);
        // The same widths after rounding (or no move): just end the preview.
        if (!wrote && previewed) preview(null);
        requestAnimationFrame(place);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
    return handle;
  }

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
  observer?.observe(content);
  requestAnimationFrame(place);

  return {
    dom,
    contentDOM: content,
    update(updated) {
      if (updated.type !== node.type) return false;
      node = updated;
      requestAnimationFrame(place);
      return true;
    },
    ignoreMutation(mutation) {
      return gutters.contains(mutation.target as Node) || mutation.target === dom;
    },
    stopEvent(event) {
      return event.target instanceof Node && gutters.contains(event.target);
    },
    destroy() {
      observer?.disconnect();
    },
  };
}
