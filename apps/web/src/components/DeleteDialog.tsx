import { useState } from "react";
import { deleteDialogBody } from "../lib/delete.js";
import { useT } from "../i18n/index.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export interface DeleteDialogProps {
  title: string;
  subPages: number;
  /** Replaces the sub-page line (D33 folders list what they hold). */
  body?: string;
  /** #7prbquxu phase 4: a database with its own rows folder: how many rows it holds (asks whether they go too). */
  rows?: number;
  /** …and how many other files (images, PDFs…) its rows folder holds. */
  rowsOtherFiles?: number;
  onCancel: () => void;
  /** `withRows`: the database's rows go to the Trash with it (default yes). */
  onConfirm: (withRows: boolean) => void;
}

/** In-app delete confirmation (D15). Cancel is focused by default. */
export function DeleteDialog({ title, subPages, body, rows, rowsOtherFiles = 0, onCancel, onConfirm }: DeleteDialogProps) {
  const t = useT();
  const [withRows, setWithRows] = useState(true);
  return (
    <ConfirmDialog
      heading={<>{t("delete.title", { title })}</>}
      body={
        rows === undefined ? (
          (body ?? deleteDialogBody(subPages))
        ) : (
          <label className="delete-with-rows">
            <input type="checkbox" data-testid="delete-with-rows" checked={withRows} onChange={(event) => setWithRows(event.target.checked)} />{" "}
            {rows > 0 ? t("bases.deleteWithRows", { count: rows }) : t("bases.deleteWithRowsFolder")}
            {rowsOtherFiles > 0 ? ` ${t("bases.deleteWithRowsOtherFiles", { count: rowsOtherFiles })}` : ""}
          </label>
        )
      }
      confirmLabel={t("common.delete")}
      testId="delete-confirm-dialog"
      cancelTestId="delete-cancel"
      confirmTestId="delete-confirm"
      onCancel={onCancel}
      onConfirm={() => onConfirm(withRows)}
    />
  );
}
