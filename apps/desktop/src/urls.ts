/**
 * Navigation policy for the desktop window (D26). Pure, unit-tested.
 *
 * - The window only ever shows the app's own origin (the in-process server).
 * - `http:`, `https:` and `mailto:` links leave the app: they open in the
 *   system browser / mail client.
 * - A vault file the app links to (`/api/files/<path>`, e.g. a PDF card) opens
 *   in the system's default app for that file.
 * - Everything else (`file:`, `javascript:`, `data:`, custom schemes) is
 *   ignored.
 */
export type NavigationAction =
  | { kind: "app" }
  | { kind: "external"; url: string }
  | { kind: "vault-file"; path: string }
  | { kind: "ignore" };

export function classifyNavigation(target: string, appOrigin: string): NavigationAction {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { kind: "ignore" };
  }
  if (url.origin === appOrigin) {
    if (url.pathname.startsWith("/api/files/")) {
      let path: string;
      try {
        path = decodeURIComponent(url.pathname.slice("/api/files/".length));
      } catch {
        return { kind: "ignore" };
      }
      // Never outside the vault: no absolute paths, no `..`, no dot folders.
      const parts = path.split("/");
      if (!path || path.startsWith("/") || parts.some((part) => part === "" || part === ".." || part.startsWith("."))) {
        return { kind: "ignore" };
      }
      return { kind: "vault-file", path };
    }
    return { kind: "app" };
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
    return { kind: "external", url: url.toString() };
  }
  return { kind: "ignore" };
}
