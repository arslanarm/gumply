/**
 * Navigation policy for the desktop window (D26). Pure, unit-tested.
 *
 * - The window only ever shows the app's own origin (the in-process server).
 * - `http:`, `https:` and `mailto:` links leave the app: they open in the
 *   system browser / mail client.
 * - A vault file the app links to (`/api/files/<path>`, e.g. a PDF card) opens
 *   in the system's default app for that file.
 * - "Show in file manager" for a trash entry (`/api/trash/<id>/reveal`,
 *   #ppag3ugh) only ever reveals the trashed file, never opens it.
 * - Everything else (`file:`, `javascript:`, `data:`, custom schemes) is
 *   ignored.
 */
export type NavigationAction =
  | { kind: "app" }
  | { kind: "external"; url: string }
  | { kind: "vault-file"; path: string }
  | { kind: "trash-reveal"; trashId: string }
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
    const reveal = /^\/api\/trash\/([A-Za-z0-9-]+)\/reveal$/.exec(url.pathname);
    if (reveal) return { kind: "trash-reveal", trashId: reveal[1]! };
    if (url.pathname.startsWith("/api/trash/") && url.pathname.endsWith("/reveal")) return { kind: "ignore" };
    return { kind: "app" };
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
    return { kind: "external", url: url.toString() };
  }
  return { kind: "ignore" };
}

/**
 * Vault files open with the system's default app only when they are plain
 * documents (#utq9azsq review). Opening a script or program (`.exe`, `.bat`,
 * `.desktop`, `.AppImage`, `.sh`, `.js`…) would run it, so everything not on
 * this list is only revealed in the file manager, never executed.
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents and text
  "pdf", "txt", "md", "markdown", "csv", "tsv", "rtf", "epub",
  "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "pages", "numbers", "key",
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "ico",
  // Audio and video
  "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "mp4", "m4v", "mov", "webm", "mkv", "avi",
  // Archives (opened by an archive manager, not extracted or run)
  "zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz",
]);

export type VaultFileAction = "open" | "reveal";

/** `open` with the default app, or only `reveal` it in the file manager. */
export function vaultFileAction(path: string): VaultFileAction {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "reveal"; // no extension, or a dot file
  return OPENABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? "open" : "reveal";
}
