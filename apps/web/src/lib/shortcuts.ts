/**
 * Keyboard-shortcut metadata for the `?` help overlay (ux-principles §9).
 * Only shortcuts that actually work belong here. Labels are read when the
 * dialog opens, so they follow the interface language (#7h5utv23).
 */
import { t } from "../i18n/index.js";

export interface Shortcut {
  keys: string;
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/** "⌘" on Apple platforms, "Ctrl" everywhere else. */
export function modifierLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

export function platformString(): string {
  if (typeof navigator === "undefined") return "";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  return data?.platform ?? navigator.platform ?? navigator.userAgent ?? "";
}

export function currentModifierLabel(): string {
  return modifierLabel(platformString());
}

export function shortcutGroups(modifier: string): ShortcutGroup[] {
  return [
    {
      title: t("shortcuts.groups.navigate"),
      items: [
        { keys: `${modifier}K`, label: t("shortcuts.labels.searchPages") },
        { keys: `${modifier}\\`, label: t("shortcuts.labels.toggleSidebar") },
        { keys: `${modifier}+Shift+D`, label: t("shortcuts.labels.openToday") },
      ],
    },
    {
      title: t("shortcuts.groups.editor"),
      items: [
        { keys: "/", label: t("shortcuts.labels.insertABlock") },
        { keys: "[[", label: t("shortcuts.labels.linkAPage") },
        { keys: "#", label: t("shortcuts.labels.heading") },
        { keys: "-", label: t("shortcuts.labels.bulletList") },
        { keys: "1.", label: t("shortcuts.labels.numberedList") },
        { keys: "- [ ]", label: t("shortcuts.labels.toDo") },
        // D29: `>` makes a toggle, `"` a quote (as in Notion).
        { keys: ">", label: t("shortcuts.labels.toggle") },
        { keys: "\"", label: t("shortcuts.labels.quote") },
        { keys: "```", label: t("shortcuts.labels.codeBlock") },
        { keys: `${modifier}Z`, label: t("shortcuts.labels.undo") },
        { keys: `${modifier}S`, label: t("shortcuts.labels.saveNow") },
        { keys: `${modifier}+Shift+↑ / ↓`, label: t("shortcuts.labels.moveBlockUpDown") },
        { keys: `${modifier}D`, label: t("shortcuts.labels.duplicateBlock") },
      ],
    },
    {
      title: t("shortcuts.groups.pages"),
      items: [
        { keys: "Enter", label: t("shortcuts.labels.titleBody") },
        { keys: `F2 / ${t("keys.doubleClick")}`, label: t("shortcuts.labels.renamePage") },
      ],
    },
    {
      title: t("shortcuts.groups.whiteboard"),
      items: [
        { keys: "V / H", label: t("shortcuts.labels.selectHand") },
        { keys: "N / T / S", label: t("shortcuts.labels.stickyNoteTextShape") },
        { keys: "C / F / P", label: t("shortcuts.labels.connectorFramePen") },
        { keys: t("keys.doubleClickCap"), label: t("shortcuts.labels.addAStickyNote") },
        { keys: "Enter", label: t("shortcuts.labels.editTheSelection") },
        { keys: `Space + ${t("keys.drag")}`, label: t("shortcuts.labels.pan") },
        { keys: `${modifier}+${t("keys.scroll")} / ${t("keys.pinch")}`, label: t("shortcuts.labels.zoom") },
        { keys: "Shift+1", label: t("shortcuts.labels.fitToScreen") },
        { keys: `${t("keys.arrows")} / Shift+${t("keys.arrows")}`, label: t("shortcuts.labels.nudgeBy110") },
        { keys: `${modifier}D`, label: t("shortcuts.labels.duplicate") },
        { keys: `${modifier}C / ${modifier}V`, label: t("shortcuts.labels.copyPaste") },
        { keys: "] / [", label: t("shortcuts.labels.bringToFrontSendToBack") },
        { keys: "Delete", label: t("shortcuts.labels.delete") },
        { keys: `${modifier}Z / ${modifier}+Shift+Z`, label: t("shortcuts.labels.undoRedo") },
      ],
    },
  ];
}

/** True when a key should type into the focused field instead of firing a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
    return true;
  }
  return target.closest('[contenteditable="true"]') !== null;
}
