import { useEffect, useId, useRef, type ReactNode } from "react";

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
 * default; Escape and a click outside cancel; Tab stays inside.
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();

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
            Cancel
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
