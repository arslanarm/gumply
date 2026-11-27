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

/**
 * Shortcuts the command palette shows next to its commands (#snuin2ja), one
 * source with this dialog: "Mod" is ⌘ or Ctrl.
 */
export const SHORTCUT_KEYS = {
  searchPages: ["Mod", "K"],
  toggleSidebar: ["Mod", "\\"],
  openToday: ["Mod", "Shift", "D"],
  toggleOutline: ["Mod", "Shift", "O"],
  shortcuts: ["?"],
  boardFit: ["Shift", "1"],
} as const satisfies Record<string, readonly string[]>;

export type ShortcutId = keyof typeof SHORTCUT_KEYS;

/**
 * The modifier and a key as each platform writes them: "⌘K" on Apple, "Ctrl+K" elsewhere
 * (#t5n77tdv: it read "CtrlK" on Windows and Linux).
 */
export function withModifier(modifier: string, key: string): string {
  return modifier === "⌘" ? `⌘${key}` : `${modifier}+${key}`;
}

/** The dialog's way of writing keys: "⌘K", "Ctrl+K", "Ctrl+Shift+D". */
function written(id: ShortcutId, modifier: string): string {
  const keys = SHORTCUT_KEYS[id].map((key) => (key === "Mod" ? modifier : key));
  return keys.length === 2 && keys[0] === modifier ? withModifier(modifier, keys[1]!) : keys.join("+");
}

export function shortcutGroups(modifier: string): ShortcutGroup[] {
  return [
    {
      title: t("shortcuts.groups.navigate"),
      items: [
        { keys: written("searchPages", modifier), label: t("shortcuts.labels.searchPages") },
        { keys: written("toggleSidebar", modifier), label: t("shortcuts.labels.toggleSidebar") },
        { keys: written("openToday", modifier), label: t("shortcuts.labels.openToday") },
        { keys: written("toggleOutline", modifier), label: t("shortcuts.labels.toggleOutline") },
        { keys: `${modifier}+Alt+O`, label: t("shortcuts.labels.toggleOutlineFallback") },
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
        { keys: `${withModifier(modifier, "Z")}`, label: t("shortcuts.labels.undo") },
        { keys: `${withModifier(modifier, "S")}`, label: t("shortcuts.labels.saveNow") },
        { keys: `${modifier}+Shift+↑ / ↓`, label: t("shortcuts.labels.moveBlockUpDown") },
        { keys: `${withModifier(modifier, "D")}`, label: t("shortcuts.labels.duplicateBlock") },
        // #e9bd64bb: with an image block selected (click it, or arrow onto it).
        { keys: "Shift+← / →", label: t("shortcuts.labels.resizeImage") },
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
      // #12 (#faqr8pj9, #5q4vaacm): a database's table, where its rows are one Tab stop.
      title: t("shortcuts.groups.database"),
      items: [
        { keys: `${t("keys.arrows")} / Tab / Shift+Tab`, label: t("shortcuts.labels.gridMove") },
        { keys: "Enter / F2", label: t("shortcuts.labels.gridEdit") },
        { keys: withModifier(modifier, "Enter"), label: t("shortcuts.labels.gridOpenRow") },
        { keys: "Esc", label: t("shortcuts.labels.gridLeave") },
        { keys: `${withModifier(modifier, "Z")} / ${modifier}+Shift+Z`, label: t("shortcuts.labels.undoRedo") },
      ],
    },
    {
      title: t("shortcuts.groups.whiteboard"),
      items: [
        { keys: "V / H", label: t("shortcuts.labels.selectHand") },
        { keys: "N / T / S", label: t("shortcuts.labels.stickyNoteTextShape") },
        { keys: "C / F / P", label: t("shortcuts.labels.connectorFramePen") },
        { keys: t("keys.doubleClickCap"), label: t("shortcuts.labels.addAStickyNote") },
        { keys: "Tab / Shift+Tab", label: t("shortcuts.labels.selectNextPrevious") },
        { keys: "Enter", label: t("shortcuts.labels.editTheSelection") },
        { keys: "N / T / S / F, Enter", label: t("shortcuts.labels.placeAtCentre") },
        { keys: "Esc", label: t("shortcuts.labels.stopEditingDeselect") },
        { keys: `Space + ${t("keys.drag")}`, label: t("shortcuts.labels.pan") },
        { keys: `${modifier}+${t("keys.scroll")} / ${t("keys.pinch")}`, label: t("shortcuts.labels.zoom") },
        { keys: written("boardFit", modifier), label: t("shortcuts.labels.fitToScreen") },
        { keys: `${t("keys.arrows")} / Shift+${t("keys.arrows")}`, label: t("shortcuts.labels.nudgeBy840") },
        { keys: `${withModifier(modifier, "D")}`, label: t("shortcuts.labels.duplicate") },
        { keys: `${withModifier(modifier, "C")} / ${withModifier(modifier, "V")}`, label: t("shortcuts.labels.copyPaste") },
        { keys: "] / [", label: t("shortcuts.labels.bringToFrontSendToBack") },
        // #b9425ktw D: align and distribute a multi-selection.
        // ⌥⇧ on a Mac, where the sheet writes ⌘ for the modifier (@opus-editor).
        { keys: `${modifier === "⌘" ? "⌥⇧" : "Alt+Shift+"}L / C / R / T / M / B`, label: t("shortcuts.labels.alignSelection") },
        { keys: `${modifier === "⌘" ? "⌥⇧" : "Alt+Shift+"}H / V`, label: t("shortcuts.labels.distributeSelection") },
        { keys: "Delete", label: t("shortcuts.labels.delete") },
        { keys: `${withModifier(modifier, "Z")} / ${modifier}+Shift+Z`, label: t("shortcuts.labels.undoRedo") },
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
