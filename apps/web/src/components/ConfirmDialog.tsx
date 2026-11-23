import { useEffect, useId, useRef, type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { useModal } from "../lib/modal.js";

export interface ConfirmDialogProps {
  heading: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  /** `data-testid` of the dialog; the buttons get `<testId>-cancel` / `-confirm`. */
  testId: string;
  /** Button ids kept for existing tests (the delete dialog). */
  cancelTestId?: string;
  confirmTestId?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * In-app confirmation for something destructive (D15). Cancel is focused by
 * default; Escape and a click outside cancel; Tab stays inside and focus
 * goes back to the opener (useModal, #vefk9dwg).
 */
export function ConfirmDialog({
  heading,
  body,
  confirmLabel,
  testId,
  cancelTestId,
  confirmTestId,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useModal(dialogRef);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
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
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        data-testid={testId}
        ref={dialogRef}
      >
        <h2 id={`${id}-title`}>{heading}</h2>
        <p id={`${id}-body`}>{body}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="button-secondary"
            data-testid={cancelTestId ?? `${testId}-cancel`}
            onClick={onCancel}
            ref={cancelRef}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="button-danger"
            data-testid={confirmTestId ?? `${testId}-confirm`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
