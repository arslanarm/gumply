import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/** #nr3rkgj2: a menu's items, in order (a disabled one is skipped). */
const MENU_ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

/**
 * A panel under its anchor (the toolbar's Filter, Sort and Properties).
 * Escape and a click outside close it; focus returns to the anchor.
 *
 * #nr3rkgj2: `menu` makes it a menu (a column's ⋯): it opens with the keyboard on its first item, the arrows,
 * Home and End move through the items, Enter runs one, Tab closes it, and the keyboard goes back to the anchor
 * when it closes (Escape, Tab, or an item that closes it).
 */
export function Popover(props: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  testId: string;
  className?: string;
  menu?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { anchor, onClose } = props;
  // Fixed under the anchor, kept inside the window (tables and tabs scroll).
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      // Under the anchor's left edge; when that would run past the window, its
      // right edge lines up with the anchor's instead (toolbar buttons at the
      // right end), then it's kept inside the window.
      const start = rect.left + width > window.innerWidth - 8 ? rect.right - width : rect.left;
      const left = Math.max(8, Math.min(start, window.innerWidth - width - 8));
      const below = rect.bottom + 4;
      const top = below + height > window.innerHeight - 8 && rect.top - height - 4 > 8 ? rect.top - height - 4 : below;
      // #bg7c9bzk (#faqr8pj9's #7): never taller than the room on its side, so it scrolls inside the window
      // rather than past it; the CSS cap is high enough that a column menu fits whole at 800 px.
      const room = top === below ? window.innerHeight - below - 8 : rect.top - 4 - 8;
      setStyle({ position: "fixed", left, top, maxHeight: Math.max(120, room) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    // Focus the first control, so the keyboard can start right away.
    panelRef.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, []);

  // #nr3rkgj2: the effect above runs while the panel is still `visibility: hidden` (before it's placed), so its
  // focus() does nothing and the keyboard stayed on the anchor. A menu takes the keyboard once it's placed.
  const menuFocused = useRef(false);
  useEffect(() => {
    if (!props.menu || menuFocused.current || style.visibility === "hidden") return;
    menuFocused.current = true;
    panelRef.current?.querySelector<HTMLElement>(`input, ${MENU_ITEMS}`)?.focus();
  }, [props.menu, style]);

  // #nr3rkgj2: a menu that closes with the keyboard inside it (an item ran) gives it back to the anchor.
  useEffect(() => {
    if (!props.menu) return;
    return () => {
      const active = document.activeElement;
      if ((!active || active === document.body) && anchor?.isConnected) anchor.focus();
    };
  }, [props.menu, anchor]);

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Tab closes the menu back on its button (the column's header), deliberately, rather than on to the next
    // control: the header is the menu button, and the next Tab goes on from there.
    if (event.key === "Tab") {
      event.preventDefault();
      onClose();
      anchor?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    // A text field in the menu (the column's new name) keeps its own Home and End.
    if ((event.target as HTMLElement).tagName === "INPUT" && (event.key === "Home" || event.key === "End")) return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    if (event.key === "Home" || event.key === "End") {
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={panelRef}
      className={`base-popover${props.className ? ` ${props.className}` : ""}`}
      role={props.menu ? "menu" : "dialog"}
      aria-label={props.label}
      {...(props.menu ? { onKeyDown: onMenuKey } : {})}
      data-testid={props.testId}
      style={style}
    >
      {props.children}
    </div>
  );
}
