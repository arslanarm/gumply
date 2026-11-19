import type { LinkSuggestion } from "../lib/wikilinks.js";

export interface LinkMenuProps {
  items: readonly LinkSuggestion[];
  index: number;
  left: number;
  top: number;
  onSelect: (item: LinkSuggestion) => void;
  onHover: (index: number) => void;
}

/** Floating `[[` menu (pages + Create row). */
export function LinkMenu({ items, index, left, top, onSelect, onHover }: LinkMenuProps) {
  return (
    <div
      className="link-menu"
      data-testid="link-menu"
      role="listbox"
      aria-label="Link a page"
      style={{ left, top }}
    >
      {items.length === 0 ? (
        <p className="link-menu-empty">No pages match</p>
      ) : (
        items.map((item, itemIndex) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={itemIndex === index}
            className={`link-menu-item${itemIndex === index ? " is-active" : ""}`}
            data-testid={
              item.kind === "page" ? `link-suggestion-${item.pageId}` : "link-suggestion-create"
            }
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
            onMouseEnter={() => onHover(itemIndex)}
          >
            <span className="link-menu-icon" aria-hidden="true">
              {item.kind === "create" ? "+" : (item.icon ?? "▤")}
            </span>
            <span className="link-menu-label">{item.label}</span>
          </button>
        ))
      )}
    </div>
  );
}
