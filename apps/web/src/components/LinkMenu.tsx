import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { isImageFile, type LinkSuggestion } from "../lib/wikilinks.js";
import { useActiveOptionVisible, usePointerMovedSinceOpen } from "./use-active-option.js";
import { useT } from "../i18n/index.js";
import { optionId } from "../lib/editor-combobox.js";

export interface LinkMenuProps {
  items: readonly LinkSuggestion[];
  index: number;
  left: number;
  top: number;
  onSelect: (item: LinkSuggestion) => void;
  onHover: (index: number) => void;
  /** The listbox id the editor's combobox attributes point at (#5nykir64). */
  id: string;
}

/** Floating `[[` menu (pages + Create row). */
export function LinkMenu({ items, index, left, top, onSelect, onHover, id }: LinkMenuProps) {
  const t = useT();
  const pointerMoved = usePointerMovedSinceOpen();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useActiveOptionVisible(menuRef, index, items.length);

  useEffect(() => {
    const menu = menuRef.current;
    setOverflowing(menu ? menu.scrollHeight > menu.clientHeight + 1 : false);
  }, [items.length]);

  return (
    <div
      ref={menuRef}
      className={`link-menu${overflowing ? " is-scrollable" : ""}`}
      data-testid="link-menu"
      id={id}
      role="listbox"
      aria-label={t("board.linkPage")}
      style={{ left, top }}
    >
      {items.length === 0 ? (
        <p className="link-menu-empty">{t("links.noMatch")}</p>
      ) : (
        items.map((item, itemIndex) => (
          <button
            key={item.key}
            type="button"
            role="option"
            id={optionId(id, itemIndex)}
            aria-selected={itemIndex === index}
            className={`link-menu-item${itemIndex === index ? " is-active" : ""}`}
            data-testid={
              item.kind === "page"
                ? `link-suggestion-${item.pageId}`
                : item.kind === "attachment"
                  ? `link-suggestion-attachment-${item.attachment?.name}`
                  : item.kind === "file"
                    ? `link-suggestion-file-${item.file?.path}`
                    : "link-suggestion-create"
            }
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
            onMouseMove={(event) => {
              if (pointerMoved(event) && itemIndex !== index) onHover(itemIndex);
            }}
          >
            <span className="link-menu-icon" aria-hidden="true">
              {item.kind === "create" ? (
                <Icon name="plus" size={16} />
              ) : item.kind === "attachment" ? (
                <Icon
                  name={item.attachment?.mime.startsWith("image/") ? "image" : "file"}
                  size={16}
                />
              ) : item.kind === "file" && item.file ? (
                <Icon name={isImageFile(item.file) ? "image" : "file"} size={16} />
              ) : item.part ? (
                <Icon name={item.part.startsWith("^") ? "grip" : "heading"} size={16} />
              ) : item.icon ? (
                item.icon
              ) : (
                <Icon name={item.board ? "board" : "file"} size={16} />
              )}
            </span>
            <span className="link-menu-label" style={item.level ? { paddingLeft: `${(item.level - 1) * 12}px` } : undefined}>
              {item.label}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
