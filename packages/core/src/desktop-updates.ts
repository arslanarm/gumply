/**
 * Desktop auto-update, as the window sees it (spec/auto-update, D42;
 * `GET/POST/PUT /api/desktop/updates`, desktop app only).
 */

/** Settings → Updates. */
export type UpdateMode = "auto" | "notify" | "off";

export const UPDATE_MODES: readonly UpdateMode[] = ["auto", "notify", "off"];

/** How this copy was installed, as far as updating goes. */
export type UpdateInstallKind = "nsis" | "appimage" | "deb" | "mac" | "none";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "pending-running"
  | "installing"
  | "read-only"
  | "install-failed"
  /** Update signing (option B): the download didn't verify, nothing is installed. */
  | "verify-failed"
  | "error";

export interface DesktopUpdatesState {
  kind: UpdateInstallKind;
  mode: UpdateMode;
  /** The choices Settings offers here ("auto" only where Gumply can install). */
  modes: UpdateMode[];
  status: UpdateStatus;
  currentVersion: string;
  /** The newer version found, if any. */
  version: string | null;
  /** Its release page: "What's new" and "Download". */
  releaseUrl: string | null;
  lastChecked: string | null;
  error: string | null;
}

/** `PUT /api/desktop/updates/settings` body. */
export interface DesktopUpdatesSettingsPatch {
  mode: UpdateMode;
}

export function isUpdateMode(value: unknown): value is UpdateMode {
  return typeof value === "string" && (UPDATE_MODES as readonly string[]).includes(value);
}
