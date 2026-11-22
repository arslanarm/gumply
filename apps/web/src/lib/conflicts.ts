/**
 * D43 (spec/sync-conflicts): shared bits for the conflict banner, list and
 * Compare dialog: how a copy is named in the UI, and what Undo does after a
 * resolve.
 */
import type { ConflictCopy, ConflictKeep, ConflictResolveResult, PageMeta } from "@gumply/core";
import { api } from "../api/client.js";
import { dateFormat, t } from "../i18n/index.js";

export function conflictToolName(tool: ConflictCopy["tool"]): string {
  return t(`conflicts.tool.${tool}` as const);
}

/**
 * The tool's own time from the copy's name. It has no time zone (Syncthing
 * writes the receiving device's local clock), so it's shown as written.
 */
export function conflictTime(at: string | undefined): string | null {
  if (!at) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(at) ? new Date(Number(at.slice(0, 4)), Number(at.slice(5, 7)) - 1, Number(at.slice(8, 10))) : new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return at.length === 10 ? dateFormat({ dateStyle: "medium" }).format(date) : dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** "Syncthing ABCDEFG, 22 Nov 2026, 14:30 (time on ABCDEFG)". */
export function conflictSource(copy: Pick<ConflictCopy, "tool" | "device" | "at">): string {
  const tool = conflictToolName(copy.tool);
  const time = conflictTime(copy.at);
  const who = copy.device ? `${tool} ${copy.device}` : tool;
  if (!time) return who;
  return `${who}, ${copy.device ? t("conflicts.localTime", { date: time, device: copy.device }) : time}`;
}

/** The toast after a resolve, and what its Undo puts back. */
export function resolvedToast(
  keep: ConflictKeep,
  copy: ConflictCopy,
  result: ConflictResolveResult,
  pages: readonly PageMeta[],
): { message: string; undo?: () => Promise<void> } {
  const title = (id: string | undefined) => pages.find((page) => page.id === id)?.title ?? id ?? "";
  const restoreCopy = async () => {
    if (result.trashId) await api.restoreTrash(result.trashId);
  };
  switch (keep) {
    case "page":
      return { message: t("conflicts.keptPage"), undo: restoreCopy };
    case "delete":
      return { message: t("conflicts.removed"), undo: restoreCopy };
    case "copy":
      return {
        message: t("conflicts.keptCopy"),
        undo: async () => {
          if (result.beforeVersion && copy.originalId) {
            const original = copy.originalId;
            const updated = copy.kind === "whiteboard" ? (await api.getBoard(original)).meta.updated : (await api.getPage(original)).updated;
            await api.restoreVersion(original, result.beforeVersion, updated);
          }
          await restoreCopy();
        },
      };
    case "both":
    case "as-original": {
      const renamed = result.renamedTo ?? "";
      const name = renamed.slice(renamed.lastIndexOf("/") + 1).replace(/\.(canvas|base)$/, "");
      return {
        message: keep === "both" ? t("conflicts.keptBoth", { title: name }) : t("conflicts.keptAs", { title: name || title(renamed) }),
        undo: async () => {
          if (renamed) await api.conflictRenameBack(renamed, copy.copyId);
        },
      };
    }
  }
}
