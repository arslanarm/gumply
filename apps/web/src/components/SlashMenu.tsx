import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.js";
import type { SlashItem } from "../editor/slash-items.js";
import { useActiveOptionVisible } from "./use-active-option.js";

export interface SlashMenuProps {
  items: readonly SlashItem[];
  index: number;
  left: number;
  top: number;
  onSelect: (item: SlashItem) => void;
  onHover: (index: number) => void;
}

const SLASH_ICONS: Record<string, IconName> = {
  "heading-1": "heading",
  "heading-2": "heading",
  "heading-3": "heading",
  "bullet-list": "list",
  "ordered-list": "listOrdered",
  todo: "checkSquare",
  quote: "quote",
  code: "code",
  divider: "minus",
};

/** Floating `/` menu. Positioned from the suggestion's client rect. */
export function SlashMenu({ items, index, left, top, onSelect, onHover }: SlashMenuProps) {
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
      className={`slash-menu${overflowing ? " is-scrollable" : ""}`}
      data-testid="slash-menu"
      role="listbox"
      aria-label="Insert block"
      style={{ left, top }}
    >
      {items.map((item, itemIndex) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={itemIndex === index}
          className={`slash-menu-item${itemIndex === index ? " is-active" : ""}`}
          data-testid={`slash-menu-item-${item.key}`}
          // Keep editor focus so the suggestion command still applies.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item);
          }}
          onMouseEnter={() => onHover(itemIndex)}
        >
          <span className="slash-menu-icon">
            <Icon name={SLASH_ICONS[item.key] ?? "file"} size={17} />
          </span>
          <span className="slash-menu-copy">
            <span className="slash-menu-title">{item.title}</span>
            <span className="slash-menu-hint">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
