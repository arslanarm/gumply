import type { PageId, PageMeta } from "@gumply/core";
import { useMemo } from "react";
import { t as translate, useT } from "../i18n/index.js";
import { isBoard } from "../lib/boards.js";
import { folderSummary } from "../lib/folders.js";
import { comparePages } from "../lib/tree.js";
import { Icon } from "./Icon.js";

export interface FolderViewProps {
  folder: PageMeta;
  pages: readonly PageMeta[];
  onOpen: (id: PageId) => void;
  onNewPage: (parentId: PageId) => void;
  onNewBoard: (parentId: PageId) => void;
}

function kindLabel(item: PageMeta): string {
  if (item.kind === "folder") return folderSummary(item.childCount, item.otherFiles);
  if (isBoard(item)) return translate("folders.whiteboard");
  if (item.kind === "base") return translate("folders.database");
  return item.childCount > 0 ? translate("folders.pageWithSubPages", { count: item.childCount }) : translate("folders.page");
}

/**
 * D33: a plain folder's overview, built from the tree only. Viewing it never
 * reads or writes a file; there is no `<Folder>.md`.
 */
export function FolderView({ folder, pages, onOpen, onNewPage, onNewBoard }: FolderViewProps) {
  const t = useT();
  const children = useMemo(
    () => pages.filter((item) => item.parentId === folder.id).sort(comparePages),
    [pages, folder.id],
  );

  return (
    <div className="folder-view" data-testid="folder-view">
      <div className="folder-view-header">
        <span className="folder-view-icon" aria-hidden="true">
          <Icon name="folderOpen" size={30} />
        </span>
        <h1 className="folder-view-title" data-testid="folder-view-title">
          {folder.title}
        </h1>
      </div>
      <p className="folder-view-meta" data-testid="folder-view-meta">
        {folderSummary(children.length, folder.otherFiles)}
      </p>
      <div className="folder-view-actions">
        <button type="button" className="button-secondary" data-testid="folder-new-page" onClick={() => onNewPage(folder.id)}>
          <Icon name="plus" size={15} />
          {t("folders.newPageHere")}
        </button>
        <button type="button" className="button-secondary" data-testid="folder-new-board" onClick={() => onNewBoard(folder.id)}>
          <Icon name="board" size={15} />
          {t("folders.newBoardHere")}
        </button>
      </div>
      {children.length === 0 ? (
        <p className="folder-view-empty" data-testid="folder-view-empty">
          {/* Other files (PDFs, images) aren't tree items, but the folder isn't empty. */}
          {(folder.otherFiles ?? 0) > 0 ? t("folders.noPagesYet") : t("folders.empty")}
        </p>
      ) : (
        <ul className="folder-view-list" aria-label={t("folders.contentsOf", { title: folder.title })}>
          {children.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="folder-view-item"
                data-testid={`folder-item-${item.id}`}
                onClick={() => onOpen(item.id)}
              >
                <span className="folder-view-item-icon" aria-hidden="true">
                  {item.kind === "folder" ? (
                    <Icon name="folder" size={17} />
                  ) : item.icon ? (
                    item.icon
                  ) : (
                    <Icon name={isBoard(item) ? "board" : item.kind === "base" ? "database" : "file"} size={17} />
                  )}
                </span>
                <span className="folder-view-item-title">{item.title}</span>
                <span className="folder-view-item-kind">{kindLabel(item)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
