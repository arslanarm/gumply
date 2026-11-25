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
  /**
   * #7vyqfcpn: the controller's change counter, raised on every change. The window
   * gets states two ways (its own requests' answers and the pushed events), in no
   * guaranteed order; it keeps the newer one (`pickUpdateState`), so a late answer
   * can't put back a state that has already moved on.
   */
  seq?: number;
}

/**
 * #7vyqfcpn: which of two update states the window should show. The incoming one,
 * unless both are stamped and it's older (a Check now answer taken mid-download
 * that arrives after the failure's push). Equal counters are the same state, or a
 * local patch of it (the window's "checking" before its request goes out).
 */
export function pickUpdateState(current: DesktopUpdatesState | null, incoming: DesktopUpdatesState): DesktopUpdatesState {
  if (current && typeof current.seq === "number" && typeof incoming.seq === "number" && incoming.seq < current.seq) return current;
  return incoming;
}

/** `PUT /api/desktop/updates/settings` body. */
export interface DesktopUpdatesSettingsPatch {
  mode: UpdateMode;
}

export function isUpdateMode(value: unknown): value is UpdateMode {
  return typeof value === "string" && (UPDATE_MODES as readonly string[]).includes(value);
}
