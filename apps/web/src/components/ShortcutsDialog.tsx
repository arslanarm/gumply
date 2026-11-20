import { useEffect, useMemo, useRef } from "react";
import { currentModifierLabel, shortcutGroups } from "../lib/shortcuts.js";

export interface ShortcutsDialogProps {
  onClose: () => void;
}

/** `?` help overlay: grouped shortcuts, focus trap and focus return. */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const groups = useMemo(() => shortcutGroups(currentModifierLabel()), []);

  useEffect(() => {
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    closeRef.current?.focus();
    return () => {
      const target = returnFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        data-testid="shortcuts-dialog"
        ref={dialogRef}
      >
        <h2 id="shortcuts-dialog-title">Keyboard shortcuts</h2>
        <p className="shortcuts-intro">
          Press <kbd>?</kbd> anywhere outside a text field or the editor to open this again.
        </p>

        <div className="shortcut-groups">
          {groups.map((group) => (
            <section className="shortcut-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.items.map((item) => (
                <div className="shortcut-row" key={`${group.title}:${item.keys}`}>
                  <span className="shortcut-keys">
                    <kbd>{item.keys}</kbd>
                  </span>
                  <span className="shortcut-label">{item.label}</span>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="button-secondary"
            data-testid="shortcuts-close"
            onClick={onClose}
            ref={closeRef}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
