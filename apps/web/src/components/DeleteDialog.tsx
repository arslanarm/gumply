import { useEffect, useRef } from "react";
import { deleteDialogBody } from "../lib/delete.js";
import { useT } from "../i18n/index.js";

export interface DeleteDialogProps {
  title: string;
  subPages: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/** In-app delete confirmation (D15). Cancel is focused by default. */
export function DeleteDialog({ title, subPages, onCancel, onConfirm }: DeleteDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])");
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
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-body"
        data-testid="delete-confirm-dialog"
        ref={dialogRef}
      >
        <h2 id="delete-dialog-title">{t("delete.title", { title })}</h2>
        <p id="delete-dialog-body">{deleteDialogBody(subPages)}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="button-secondary"
            data-testid="delete-cancel"
            onClick={onCancel}
            ref={cancelRef}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="button-danger"
            data-testid="delete-confirm"
            onClick={onConfirm}
          >
            {t("common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
