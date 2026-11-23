import { useEffect, useMemo, useRef } from "react";
import { currentModifierLabel, shortcutGroups } from "../lib/shortcuts.js";
import { useT } from "../i18n/index.js";
import { useModal } from "../lib/modal.js";

export interface ShortcutsDialogProps {
  onClose: () => void;
}

/** `?` help overlay: grouped shortcuts, focus trap and focus return. */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const groups = useMemo(() => shortcutGroups(currentModifierLabel()), []);
  // Focus trap and focus return (#vefk9dwg).
  useModal(dialogRef);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
        <h2 id="shortcuts-dialog-title">{t("shortcuts.title")}</h2>
        <p className="shortcuts-intro">
          {t("shortcuts.introBefore")}<kbd>?</kbd>{t("shortcuts.introAfter")}
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
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
