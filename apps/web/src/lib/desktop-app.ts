/**
 * #vhdp68sm (N8): running inside the desktop app, and opening a page in a new
 * window there. The web app learns it from `/api/health` (`desktop: true`);
 * the desktop app turns an in-app `window.open` into a new Gumply window on
 * the same vault (a browser would open a tab, so the commands only show on
 * desktop).
 */
import type { PageId } from "@gumply/core";

let desktopApp = false;

/** Set once from `/api/health`. */
export function setDesktopApp(value: boolean): void {
  desktopApp = value;
}

/** The desktop app (not a browser tab): "Open in new window" applies. */
export function isDesktopApp(): boolean {
  return desktopApp;
}

/** The app's own address for a page, as a new window opens it. */
export function pageWindowUrl(id: PageId, location: Pick<Location, "origin" | "pathname"> = window.location): string {
  return `${location.origin}${location.pathname}#/${encodeURIComponent(id)}`;
}

/** Open `id` in a new desktop window (the desktop app makes the window; nothing here when it isn't one). */
export function openInNewWindow(id: PageId): void {
  if (!desktopApp) return;
  window.open(pageWindowUrl(id), "_blank");
}

/** A click that asks for a new window: Cmd (macOS) or Ctrl (elsewhere) held, in the desktop app. */
export function wantsNewWindow(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): boolean {
  return desktopApp && (event.metaKey || event.ctrlKey);
}
