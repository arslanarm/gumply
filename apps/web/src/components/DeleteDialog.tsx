import { deleteDialogBody } from "../lib/delete.js";
import { useT } from "../i18n/index.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export interface DeleteDialogProps {
  title: string;
  subPages: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/** In-app delete confirmation (D15). Cancel is focused by default. */
export function DeleteDialog({ title, subPages, onCancel, onConfirm }: DeleteDialogProps) {
  const t = useT();
  return (
    <ConfirmDialog
      heading={<>{t("delete.title", { title })}</>}
      body={deleteDialogBody(subPages)}
      confirmLabel={t("common.delete")}
      testId="delete-confirm-dialog"
      cancelTestId="delete-cancel"
      confirmTestId="delete-confirm"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
