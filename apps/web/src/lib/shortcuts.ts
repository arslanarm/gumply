/**
 * Keyboard-shortcut metadata for the `?` help overlay (ux-principles §9).
 * Only shortcuts that actually work belong here.
 */

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
      title: "Navigate",
      items: [
        { keys: `${modifier}K`, label: "Search pages" },
        { keys: `${modifier}\\`, label: "Toggle sidebar" },
      ],
    },
    {
      title: "Editor",
      items: [
        { keys: "/", label: "Insert a block" },
        { keys: "[[", label: "Link a page" },
        { keys: "#", label: "Heading" },
        { keys: "-", label: "Bullet list" },
        { keys: "1.", label: "Numbered list" },
        { keys: "- [ ]", label: "To-do" },
        { keys: ">", label: "Quote" },
        { keys: "```", label: "Code block" },
        { keys: `${modifier}Z`, label: "Undo" },
        { keys: `${modifier}S`, label: "Save now" },
        { keys: `${modifier}+Shift+↑ / ↓`, label: "Move block up / down" },
        { keys: `${modifier}D`, label: "Duplicate block" },
      ],
    },
    {
      title: "Pages",
      items: [
        { keys: "Enter", label: "Title → body" },
        { keys: "F2 / double-click", label: "Rename page" },
      ],
    },
    {
      title: "Whiteboard",
      items: [
        { keys: "V / H", label: "Select / Hand" },
        { keys: "N / T / S", label: "Sticky note / Text / Shape" },
        { keys: "C / F / P", label: "Connector / Frame / Pen" },
        { keys: "Double-click", label: "Add a sticky note" },
        { keys: "Enter", label: "Edit the selection" },
        { keys: "Space + drag", label: "Pan" },
        { keys: `${modifier}+scroll / pinch`, label: "Zoom" },
        { keys: "Shift+1", label: "Fit to screen" },
        { keys: "Arrows / Shift+Arrows", label: "Nudge by 1 / 10" },
        { keys: `${modifier}D`, label: "Duplicate" },
        { keys: `${modifier}C / ${modifier}V`, label: "Copy / paste" },
        { keys: "] / [", label: "Bring to front / send to back" },
        { keys: "Delete", label: "Delete" },
        { keys: `${modifier}Z / ${modifier}+Shift+Z`, label: "Undo / redo" },
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
