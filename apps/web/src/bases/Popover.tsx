import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * A panel under its anchor (the toolbar's Filter, Sort and Properties).
 * Escape and a click outside close it; focus returns to the anchor.
 */
export function Popover(props: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  testId: string;
  className?: string;
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
      setStyle({ position: "fixed", left, top });
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

  return (
    <div
      ref={panelRef}
      className={`base-popover${props.className ? ` ${props.className}` : ""}`}
      role="dialog"
      aria-label={props.label}
      data-testid={props.testId}
      style={style}
    >
      {props.children}
    </div>
  );
}
