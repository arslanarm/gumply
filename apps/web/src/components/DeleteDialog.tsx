import { deleteDialogBody } from "../lib/delete.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export interface DeleteDialogProps {
  title: string;
  subPages: number;
  /** Replaces the sub-page line (D33 folders list what they hold). */
  body?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** In-app delete confirmation (D15). Cancel is focused by default. */
export function DeleteDialog({ title, subPages, body, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <ConfirmDialog
      heading={<>Delete “{title}”?</>}
      body={body ?? deleteDialogBody(subPages)}
      confirmLabel="Delete"
      testId="delete-confirm-dialog"
      cancelTestId="delete-cancel"
      confirmTestId="delete-confirm"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
