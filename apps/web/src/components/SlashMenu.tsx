import type { SlashItem } from "../editor/slash-items.js";

export interface SlashMenuProps {
  items: readonly SlashItem[];
  index: number;
  left: number;
  top: number;
  onSelect: (item: SlashItem) => void;
  onHover: (index: number) => void;
}

/** Floating `/` menu. Positioned from the suggestion's client rect. */
export function SlashMenu({ items, index, left, top, onSelect, onHover }: SlashMenuProps) {
  return (
    <div
      className="slash-menu"
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
          <span className="slash-menu-title">{item.title}</span>
          <span className="slash-menu-hint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}
