import { deleteDialogBody } from "../lib/delete.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export interface DeleteDialogProps {
  title: string;
  subPages: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/** In-app delete confirmation (D15). Cancel is focused by default. */
export function DeleteDialog({ title, subPages, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <ConfirmDialog
      heading={<>Delete “{title}”?</>}
      body={deleteDialogBody(subPages)}
      confirmLabel="Delete"
      testId="delete-confirm-dialog"
      cancelTestId="delete-cancel"
      confirmTestId="delete-confirm"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
