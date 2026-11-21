/**
 * The window and tab title (#ux5cukze): "<Page> — <Vault folder> — Gumply".
 * The desktop app shows `document.title` as the window title, so with
 * several vaults open you can tell the windows apart.
 */
export function windowTitle(parts: { page?: string | null; vaultPath?: string | null }): string {
  const vault = vaultName(parts.vaultPath ?? "");
  return [parts.page?.trim(), vault, "Gumply"].filter((part): part is string => Boolean(part)).join(" — ");
}

/** The vault's folder name, from an absolute path on any OS. */
export function vaultName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}
