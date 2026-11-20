import { useRef } from "react";
import type { EmojiEntry } from "../lib/emoji/data.js";
import { useActiveOptionVisible, usePointerMovedSinceOpen } from "./use-active-option.js";

export interface EmojiMenuProps {
  items: readonly EmojiEntry[];
  index: number;
  left: number;
  top: number;
  onSelect: (item: EmojiEntry) => void;
  onHover: (index: number) => void;
}

/** Floating `:roc` emoji suggestions (#6v8tyxfd). */
export function EmojiMenu({ items, index, left, top, onSelect, onHover }: EmojiMenuProps) {
  const pointerMoved = usePointerMovedSinceOpen();
  const menuRef = useRef<HTMLDivElement | null>(null);
  useActiveOptionVisible(menuRef, index, items.length);

  return (
    <div
      ref={menuRef}
      className="slash-menu emoji-menu"
      data-testid="emoji-menu"
      role="listbox"
      aria-label="Emoji"
      style={{ left, top }}
    >
      {items.map((item, itemIndex) => {
        const code = item.shortcodes[0];
        return (
          <button
            key={item.emoji}
            type="button"
            role="option"
            aria-selected={itemIndex === index}
            className={`slash-menu-item emoji-menu-item${itemIndex === index ? " is-active" : ""}`}
            data-testid={`emoji-suggestion-${code ?? item.name}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
            onMouseMove={(event) => {
              if (pointerMoved(event) && itemIndex !== index) onHover(itemIndex);
            }}
          >
            <span className="emoji-menu-glyph" aria-hidden="true">
              {item.emoji}
            </span>
            <span className="emoji-menu-name">{item.name}</span>
            {code ? <span className="emoji-menu-code">:{code}:</span> : null}
          </button>
        );
      })}
    </div>
  );
}
