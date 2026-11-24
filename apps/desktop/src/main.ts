/**
 * Gumply desktop (D26): an Electron shell around the existing server.
 *
 * - The server runs in-process on 127.0.0.1 with a random free port and the
 *   chosen vault, and also serves the built web app, so the window loads one
 *   origin and all the web app's security rules (#rv57cvhm) apply unchanged.
 * - The window is sandboxed (contextIsolation, no Node, sandbox) with no
 *   preload API. It never navigates off the app origin: web and mail links
 *   open in the system browser, vault files in their default app.
 * - Settings (last/recent vaults, window state) live in `userData`, never in
 *   a vault.
 */
import { appendFileSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from "electron";
import { startGumplyServer, type RunningServer } from "../../server/src/start.js";
import { logUnhandledRejections } from "../../server/src/last-resort.js";
import type { DesktopUpdates } from "../../server/src/desktop-updates.js";
import { applyUiStateChange, type UiState, type UiStateChange, type UiStateStore } from "../../server/src/ui-state.js";
import {
  loadSettings,
  saveSettings,
  withOpenedVault,
  withoutRecentVault,
  type DesktopSettings,
  type WindowState,
} from "./settings.js";
import { isAppDownload, isPrintDownload, pdfName, suggestedName } from "./downloads.js";
import { describeFlushes, flushAllSaved, NO_ANSWER, unsavedWindowNames, type WindowFlush } from "./flush-report.js";
import { desktopT, resolveDesktopLanguage } from "./i18n.js";
import { spellcheckLanguages } from "./spellcheck.js";
import { classifyNavigation, userGuideUrl, vaultFileAction, newWindowUrl } from "./urls.js";
import { exitMcp, hasFusermount, MCP_MODE_USAGE, mcpLaunchCommand, mcpModeArgs, mcpTracer, userNamespacesWork, type McpModeArgs } from "./mcp-mode.js";
import { runMcp } from "../../mcp/src/run.js";
import { installKind, listWindowsProcesses, UpdateController, type UpdaterLike } from "./updates.js";

/**
 * Launch phases with the process's age in ms (#tcw8r7vc), kept for the
 * desktop tests: a slow first launch then says which phase was slow.
 */
const launchPhases: Array<[string, number]> = [];
(globalThis as { __gumplyLaunchPhases?: Array<[string, number]> }).__gumplyLaunchPhases = launchPhases;
function launchPhase(phase: string): void {
  launchPhases.push([phase, Math.round(process.uptime() * 1000)]);
}
launchPhase("main-loaded");

const here = dirname(fileURLToPath(import.meta.url));
/** The built web app, copied next to this bundle by scripts/build.mjs. */
const WEB_ROOT = join(here, "web");
const isDev = !app.isPackaged;

/**
 * THIRD_PARTY_NOTICES (#mbim529b): shipped next to the app as a .txt (opens
 * on every OS without asking which app to use); in dev, the repo's .md.
 */
export function noticesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "THIRD_PARTY_NOTICES.txt")
    : join(here, "..", "..", "..", "THIRD_PARTY_NOTICES.md");
}

// One settings folder in dev and packaged builds: ~/.config/Gumply on Linux
// (dev would otherwise use the package name, "@gumply/desktop").
// #35q6kt6e: a rejection nothing handled (in the shell or the in-process
// server) is logged, never the end of the app. Installed once per process.
logUnhandledRejections();
app.setName("Gumply");
// Tests (and anyone who wants a separate profile) can move the settings.
if (process.env.GUMPLY_DESKTOP_USER_DATA) app.setPath("userData", resolve(process.env.GUMPLY_DESKTOP_USER_DATA));

/**
 * A3: `--mcp` launches never touch the app's settings folder (recent vaults,
 * window state). Chromium still keeps some state of its own (Local State,
 * GPU cache, crash reports): it goes to a throwaway folder, removed on exit.
 */
// The first user argument: after the executable when packaged, after the app folder in development.
const mcpMode = mcpModeArgs(process.argv, app.isPackaged ? 1 : 2);
// GUMPLY_MCP_TRACE=<file>: the --mcp support trace (docs/mcp.md), a no-op when unset.
const trace = mcpTracer(process.env.GUMPLY_MCP_TRACE, appendFileSync);
if (mcpMode && process.env.GUMPLY_MCP_TRACE) {
  const fdKind = (fd: number): string => {
    try {
      const stats = fstatSync(fd);
      return stats.isFIFO() ? "fifo" : stats.isCharacterDevice() ? "char" : stats.isFile() ? "file" : stats.isSocket() ? "socket" : "other";
    } catch (error) {
      return `error:${(error as NodeJS.ErrnoException).code ?? "?"}`;
    }
  };
  trace(`gumply ${app.getVersion()} argv=${JSON.stringify(process.argv)} packaged=${app.isPackaged} mcp=${JSON.stringify(mcpMode)} fds=${[0, 1, 2].map(fdKind).join(",")}`);
}
let mcpThrowaway: string | null = null;
if (mcpMode) {
  // A process stopped by a signal can't clean up: older leftovers go now.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("gumply-mcp-")) continue;
      const path = join(tmpdir(), name);
      if (statSync(path).mtimeMs < dayAgo) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Not ours to fail on.
  }
  const throwaway = mkdtempSync(join(tmpdir(), "gumply-mcp-"));
  mcpThrowaway = throwaway;
  app.setPath("userData", throwaway);
  app.setPath("sessionData", throwaway);
  app.setPath("crashDumps", join(throwaway, "Crashpad"));
  app.disableHardwareAcceleration();
  const removeThrowaway = () => rmSync(throwaway, { recursive: true, force: true });
  process.on("exit", removeThrowaway);
  app.on("will-quit", removeThrowaway);
}

/** G2: per launch; the app's page gets it from /api/health and names print hand-offs with it. */
const printToken = randomBytes(12).toString("hex");

let settings: DesktopSettings;
let server: RunningServer | null = null;
let vaultPath: string | null = null;
/**
 * #vhdp68sm (N8): the app's windows, all on the same vault and server. The first is the main
 * window: its size and position are remembered, and it's the one a vault switch reloads. Commands
 * from the menu go to the window in front.
 */
const windows = new Set<BrowserWindow>();
let mainWindow: BrowserWindow | null = null;

/** Every window still open. */
function liveWindows(): BrowserWindow[] {
  return [...windows].filter((win) => !win.isDestroyed());
}

/** The window in front (focused), else the main one, else any: menus, dialogs and commands go here. */
function activeWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return liveWindows()[0] ?? null;
}
/** Set once the pages are flushed and the app may really quit (#3t6v62cb). */
let quitting = false;
/** Auto-update (spec/auto-update, D42); null in development, unpacked and `--mcp` runs. */
let updates: UpdateController | null = null;
/** "Restart now": install at this quit, then start again. */
let restartAfterQuit = false;

/**
 * The menu and dialog language (#7h5utv23): the app's `gumply:language`
 * preference (mirrored here with its other preferences, #c7fzzxk8), else the
 * system's.
 */
const LANGUAGE_KEY = "gumply:language";
function tr(key: string, vars?: Record<string, string | number>): string {
  return desktopT(resolveDesktopLanguage(settings?.uiState[LANGUAGE_KEY], app.getLocale()), key, vars);
}

function persist(next: DesktopSettings): void {
  settings = next;
  try {
    saveSettings(app.getPath("userData"), settings);
  } catch (error) {
    console.error("[gumply-desktop] could not save settings:", error);
  }
}

// --- UI preferences (#c7fzzxk8) -------------------------------------------
// The window loads the app from a random port, so its `localStorage` starts
// empty on every launch. The app mirrors its `gumply:*` keys to the server
// (`GET/PUT /api/ui/state`), which keeps them here, in the desktop settings.

type UiStateListener = (change: UiStateChange, state: UiState) => void;
const uiStateListeners = new Set<UiStateListener>();

/** React to preference changes (e.g. rebuild the menu for `gumply:language`). */
export function onUiStateChange(listener: UiStateListener): () => void {
  uiStateListeners.add(listener);
  return () => uiStateListeners.delete(listener);
}

const uiStateStore: UiStateStore = {
  get: () => settings.uiState,
  update: (change) => {
    const next = applyUiStateChange(settings.uiState, change);
    persist({ ...settings, uiState: next });
    for (const listener of uiStateListeners) listener(change, next);
    return next;
  },
};

/**
 * Spellcheck follows the app's language (1.0 N3): the interface language's
 * dictionary first, then the system's own when it's another language. macOS
 * uses the system spellchecker, which picks languages itself.
 */
function applySpellcheckLanguages(): void {
  if (process.platform === "darwin" || !app.isReady()) return;
  const spellcheck = session.defaultSession;
  const ui = resolveDesktopLanguage(settings?.uiState[LANGUAGE_KEY], app.getLocale());
  const languages = spellcheckLanguages(ui, app.getLocale(), spellcheck.availableSpellCheckerLanguages);
  if (languages.length === 0) return;
  try {
    spellcheck.setSpellCheckerLanguages(languages);
  } catch (error) {
    console.error("[gumply-desktop] could not set the spellcheck languages:", error);
  }
}

// A new interface language in the app: the menu and spellcheck follow it (#7h5utv23, N3).
onUiStateChange((change) => {
  if (change.set?.[LANGUAGE_KEY] !== undefined || change.remove?.includes(LANGUAGE_KEY)) {
    buildMenu();
    applySpellcheckLanguages();
  }
});

/**
 * The saved theme paints the first frame: Electron's own theme follows it
 * while the page loads (the page's pre-paint script reads the system theme
 * then), and goes back to "system" once the page has its preferences.
 */
function themeForFirstPaint(): void {
  const saved = settings.uiState["gumply:theme"];
  nativeTheme.themeSource = saved === "dark" || saved === "light" ? saved : "system";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- vault ---------------------------------------------------------------

async function pickExistingVault(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: tr("vault.openTitle"),
    message: tr("vault.openMessage"),
    buttonLabel: tr("vault.openButton"),
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
}

async function pickNewVault(): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: tr("vault.createTitle"),
    message: tr("vault.createMessage"),
    buttonLabel: tr("vault.createButton"),
    defaultPath: join(app.getPath("documents"), "Gumply"),
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;
  mkdirSync(result.filePath, { recursive: true });
  return result.filePath;
}

/** First start: explain, then open or create a vault (or quit). */
async function chooseFirstVault(): Promise<string | null> {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: tr("vault.welcomeTitle"),
      message: tr("vault.welcomeMessage"),
      detail: tr("vault.welcomeDetail"),
      buttons: [tr("vault.welcomeOpen"), tr("vault.welcomeCreate"), tr("vault.welcomeQuit")],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return null;
    const picked = response === 0 ? await pickExistingVault() : await pickNewVault();
    if (picked) return picked;
  }
}

async function openVault(path: string): Promise<void> {
  const target = resolve(path);
  if (!isDirectory(target)) {
    await dialog.showMessageBox({ type: "warning", message: tr("vault.missing"), detail: target });
    persist(withoutRecentVault(settings, target));
    buildMenu();
    return;
  }
  const previous = server;
  if (previous) {
    // Save what the page still holds before switching (#3t6v62cb).
    if (!(await flushRenderer()) && !(await confirmUnsaved("switchVaults"))) return;
    server = null;
    await previous.close();
  }

  launchPhase("server-starting");
  server = await startGumplyServer({
    vaultPath: target,
    // A random free port; GUMPLY_DESKTOP_PORT pins one (tests, debugging).
    port: Number(process.env.GUMPLY_DESKTOP_PORT ?? 0) || 0,
    host: "127.0.0.1",
    seedDemo: true,
    webRoot: WEB_ROOT,
    // The installer's version (set from the release tag), not the source default.
    version: app.getVersion(),
    desktop: true,
    uiState: uiStateStore,
    // spec/auto-update: Settings → Updates and the notice (only when this install can update or be told).
    ...(updates ? { updates: updatesForServer(updates) } : {}),
    // A3: Settings → MCP shows AI apps how to start this app's --mcp mode.
    mcpCommand: mcpLaunchCommand({
      execPath: process.execPath,
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      platform: process.platform,
      ...(process.env.APPIMAGE ? { appImage: process.env.APPIMAGE, fusermount: hasFusermount(existsSync) } : {}),
      ...(process.platform === "linux" && !app.isPackaged
        ? { userNamespaces: userNamespacesWork(existsSync, (command, args) => spawnSync(command, args, { stdio: "ignore", timeout: 2000 }).status) }
        : {}),
    }),
    printToken,
    log: (message) => console.log(message),
  });
  launchPhase("server-started");
  vaultPath = target;
  persist(withOpenedVault(settings, target));
  buildMenu();

  themeForFirstPaint();
  // A vault switch keeps only the main window, on the new vault (other windows showed the old one).
  for (const win of liveWindows()) if (win !== mainWindow) win.destroy();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ main: true });
    launchPhase("window-created");
  }
  try {
    await mainWindow!.loadURL(`${server.url}/`);
    launchPhase("page-loaded");
  } finally {
    nativeTheme.themeSource = "system";
  }
}

/**
 * Ask the page to save everything now and wait for the server to confirm
 * (#3t6v62cb). The web app exposes `window.__gumplyFlush()` (no preload or
 * IPC, D26); it resolves within 10 s with whether everything is on disk
 * (#8zc7xkgq: 3 s made a slow-but-fine save on a busy machine look failed).
 */
const FLUSH_WAIT_MS = 11_000;

/** Ask one window's page to save everything; its answer, or NO_ANSWER after the wait. */
async function flushWindow(win: BrowserWindow): Promise<WindowFlush> {
  const name = win.isDestroyed() ? "" : win.getTitle();
  if (win.isDestroyed()) return { name, result: true };
  try {
    const result: unknown = await Promise.race([
      win.webContents.executeJavaScript(
        "window.__gumplyFlush ? window.__gumplyFlush() : (document.activeElement instanceof HTMLElement && document.activeElement.blur(), new Promise((r) => setTimeout(() => r(true), 800)))",
      ),
      new Promise((resolve) => setTimeout(() => resolve(NO_ANSWER), FLUSH_WAIT_MS)),
    ]);
    return { name, result };
  } catch {
    return { name, result: true }; // the page is gone already: nothing left to save
  }
}

/**
 * Save what the given windows (default: all of them, at once) still hold and wait for the server
 * (#3t6v62cb). True when everything is on disk. Quitting and a vault switch ask every window;
 * closing one window asks only it.
 */
async function flushRenderer(only?: BrowserWindow): Promise<boolean> {
  const targets = only ? [only] : liveWindows();
  const results = await Promise.all(targets.map((win) => flushWindow(win)));
  // Why the dialog will show (#ms44vnit): logged, and readable by the tests.
  unsavedDialog.reason = describeFlushes(results, FLUSH_WAIT_MS);
  unsavedDialog.windows = unsavedWindowNames(results);
  if (unsavedDialog.reason) console.warn(`Not everything is saved: ${unsavedDialog.reason}`);
  return flushAllSaved(results);
}

/**
 * Whether the "couldn't be saved" dialog is up, and why the last flush
 * wasn't complete. Readable from the main process
 * (`globalThis.__gumplyUnsavedDialog`) so a test that waits for the app to
 * quit can say why it didn't, instead of timing out blind.
 */
const unsavedDialog: { open: boolean; reason: string | null; windows: string[] } = { open: false, reason: null, windows: [] };
(globalThis as { __gumplyUnsavedDialog?: typeof unsavedDialog }).__gumplyUnsavedDialog = unsavedDialog;

/** The flush failed: ask before losing those edits. */
async function confirmUnsaved(action: "switchVaults" | "close" | "quit"): Promise<boolean> {
  // N8: with several windows open, say which ones hold the unsaved work.
  const named = liveWindows().length > 1 && unsavedDialog.windows.length > 0;
  const options = {
    type: "warning" as const,
    buttons: [tr(`unsaved.${action}`), tr("unsaved.cancel")],
    defaultId: 1,
    cancelId: 1,
    message: tr("unsaved.message"),
    detail: named
      ? tr("unsaved.detailWindows", {
          detail: tr("unsaved.detail"),
          // Each name in the language's own quotes (“…” / «…»).
          windows: unsavedDialog.windows.map((name) => tr("unsaved.windowName", { name })).join(", "),
          // One window or several: ru says «в окне» / «в окнах».
          count: unsavedDialog.windows.length,
        })
      : tr("unsaved.detail"),
  };
  unsavedDialog.open = true;
  try {
    const parent = activeWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === 0;
  } finally {
    unsavedDialog.open = false;
  }
}

// --- window --------------------------------------------------------------

function initialBounds(): Partial<WindowState> {
  const saved = settings.window;
  const fallback = { width: 1280, height: 820 };
  if (!saved) return fallback;
  // Ignore a position that is off every screen (a monitor was unplugged).
  if (saved.x !== undefined && saved.y !== undefined) {
    const visible = screen.getAllDisplays().some(({ workArea }) => {
      return (
        saved.x! < workArea.x + workArea.width - 80 &&
        saved.x! + saved.width > workArea.x + 80 &&
        saved.y! < workArea.y + workArea.height - 40 &&
        saved.y! >= workArea.y - 40
      );
    });
    if (!visible) return { width: saved.width, height: saved.height };
  }
  return saved;
}

function createWindow({ main }: { main: boolean }): BrowserWindow {
  // Only the main window opens where it was; another opens at the default size, placed by the system.
  const bounds = main ? initialBounds() : {};
  const window = new BrowserWindow({
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    width: bounds.width ?? 1280,
    height: bounds.height ?? 820,
    minWidth: 400,
    minHeight: 300,
    show: false,
    title: "Gumply",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      devTools: isDev,
    },
  });
  windows.add(window);
  if (main) mainWindow = window;
  if (main && settings.window?.maximized) window.maximize();
  // The window title is the page's own `document.title` (the web app names
  // the page and the vault, #ux5cukze).
  window.once("ready-to-show", () => window.show());

  const contents = window.webContents;
  // N3: Chromium starts its spellcheck service with the first page, and may set
  // its own default languages then; ours are applied again once it has loaded.
  contents.once("did-finish-load", () => applySpellcheckLanguages());
  const appOrigin = () => (server ? new URL(server.url).origin : "");

  const handle = (url: string): boolean => {
    const action = classifyNavigation(url, appOrigin());
    if (action.kind === "app") return true;
    if (action.kind === "external") void shell.openExternal(action.url);
    else if (action.kind === "vault-file" && vaultPath) openVaultFile(action.path);
    else if (action.kind === "trash-reveal" && vaultPath) revealTrashed(action.trashId);
    return false;
  };
  contents.on("will-navigate", (event, url) => {
    if (!handle(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!handle(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // N8: "Open in new window" (the app's own page) becomes a Gumply window on the same vault.
    const page = newWindowUrl(url, appOrigin());
    if (page) {
      openAppWindow(page);
      return { action: "deny" };
    }
    // Anything else never opens a window; links are handed to the system.
    const action = classifyNavigation(url, appOrigin());
    if (action.kind === "external") void shell.openExternal(action.url);
    else if (action.kind === "vault-file" && vaultPath) openVaultFile(action.path);
    else if (action.kind === "trash-reveal" && vaultPath) revealTrashed(action.trashId);
    return { action: "deny" };
  });

  const saveState = () => {
    // Only the main window's place is remembered (N8).
    if (window !== mainWindow || window.isDestroyed()) return;
    const maximized = window.isMaximized();
    const normal = window.getNormalBounds();
    persist({ ...settings, window: { x: normal.x, y: normal.y, width: normal.width, height: normal.height, maximized } });
  };
  // Closing the window first saves what the page still holds (#3t6v62cb).
  let closeReady = false;
  window.on("close", (event) => {
    saveState();
    if (closeReady || quitting) return;
    event.preventDefault();
    void (async () => {
      // N8: closing one window saves only what that window holds.
      if (!(await flushRenderer(window)) && !(await confirmUnsaved("close"))) return;
      closeReady = true;
      if (!window.isDestroyed()) window.close();
    })();
  });
  // The page asks to stay ("Leave site?", only when a save can't go out):
  // Electron would just cancel the close silently, so ask natively.
  contents.on("will-prevent-unload", (event) => {
    const target = !window.isDestroyed() ? window : null;
    const options = {
      type: "warning" as const,
      buttons: [tr("unsaved.leave"), tr("unsaved.stay")],
      defaultId: 1,
      cancelId: 1,
      message: tr("unsaved.leaveMessage"),
      detail: tr("unsaved.leaveDetail"),
    };
    const choice = target ? dialog.showMessageBoxSync(target, options) : dialog.showMessageBoxSync(options);
    if (choice === 0) event.preventDefault();
  });
  window.on("closed", () => {
    windows.delete(window);
    // The main window went first: another one takes its place (and its remembered bounds from now on).
    if (mainWindow === window) mainWindow = [...windows].find((win) => !win.isDestroyed()) ?? null;
  });
  return window;
}

/** N8: another window on the open vault, at `url` (the app's page; File → New Window opens its start). */
function openAppWindow(url?: string): void {
  if (!server) return;
  const win = createWindow({ main: false });
  void win.loadURL(url ?? `${server.url}/`).catch((error: unknown) => console.error("[gumply] new window failed:", error));
}

/**
 * Open a vault file the app links to (e.g. a PDF card). Documents open in
 * their default app; anything that could run (scripts, programs, launchers)
 * is only shown in the file manager. Checked on the real path, so a symlink
 * named `x.pdf` pointing at a program, or out of the vault, isn't opened.
 */
function openVaultFile(path: string): void {
  if (!vaultPath) return;
  let real: string;
  let vaultReal: string;
  try {
    real = realpathSync(resolve(vaultPath, path));
    vaultReal = realpathSync(vaultPath);
  } catch {
    return; // missing file
  }
  if (!real.startsWith(`${vaultReal}${sep}`) || !statSync(real).isFile()) return;
  if (vaultFileAction(real) === "open") void shell.openPath(real);
  else shell.showItemInFolder(real);
}

/**
 * "Show in file manager" for a trash entry (#ppag3ugh): select the trashed
 * page or board in the file manager. Only ever revealed, never opened (a
 * trashed file can be anything). The entry must be a real folder inside the
 * vault's `.trash/`, and the file must stay inside it; otherwise the entry
 * folder itself is shown, or nothing.
 */
function revealTrashed(trashId: string): void {
  if (!vaultPath || !/^[A-Za-z0-9-]+$/.test(trashId)) return;
  let entry: string;
  try {
    const trashRoot = realpathSync(join(vaultPath, ".trash"));
    entry = realpathSync(join(trashRoot, trashId));
    if (!trashRoot.startsWith(`${realpathSync(vaultPath)}${sep}`) || !entry.startsWith(`${trashRoot}${sep}`)) return;
    if (!statSync(entry).isDirectory()) return;
  } catch {
    return; // gone (restored or deleted meanwhile)
  }
  let target = entry;
  try {
    const manifest = JSON.parse(readFileSync(join(entry, "meta.json"), "utf8")) as { file?: unknown; id?: unknown };
    const file = typeof manifest.file === "string" ? manifest.file : typeof manifest.id === "string" ? `${manifest.id}.md` : null;
    if (file) {
      const real = realpathSync(resolve(entry, file));
      if (real.startsWith(`${entry}${sep}`) && statSync(real).isFile()) target = real;
    }
  } catch {
    // No usable manifest or file: show the entry folder.
  }
  shell.showItemInFolder(target);
}

/**
 * G2: print a page the web app built (G1's self-contained document, light,
 * with an @page rule) to PDF. A hidden window on its own throwaway session
 * loads only that file: no script, no preload, and every other request is
 * cancelled. Then the native Save dialog (tests: GUMPLY_DESKTOP_DOWNLOAD_DIR).
 */
async function printToPdf(htmlPath: string, name: string, scratchDir: string): Promise<void> {
  const documentUrl = pathToFileURL(htmlPath).href;
  const printSession = session.fromPartition(`gumply-print-${Date.now()}`, { cache: false });
  const blocked: string[] = [];
  printSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === documentUrl || details.url.startsWith("data:");
    if (!allowed) blocked.push(details.url);
    callback({ cancel: !allowed });
  });
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { session: printSession, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  printWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    await printWindow.loadURL(documentUrl);
    const pdf = await printWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const testDir = process.env.GUMPLY_DESKTOP_DOWNLOAD_DIR;
    let target: string | undefined;
    if (testDir) target = join(resolve(testDir), name);
    else {
      const options = {
        title: tr("export.saveTitle"),
        defaultPath: join(app.getPath("downloads"), name),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      };
      const parent = activeWindow();
      const answer = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      target = answer.canceled ? undefined : answer.filePath;
    }
    if (target) writeFileSync(target, pdf);
  } finally {
    // Tests read what was refused (nothing should ever be).
    const record = globalThis as { __gumplyPrintBlocked?: string[] };
    record.__gumplyPrintBlocked = [...(record.__gumplyPrintBlocked ?? []), ...blocked];
    printWindow.destroy();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** #snuin2ja: the web app's command ids (lib/commands.ts), so the menu and Cmd+K run the same action. */
function sendCommand(command: "new.page" | "new.board" | "view.search" | "page.import-notion" | "page.export-pdf"): void {
  // N8: the menu acts on the window in front.
  const target = activeWindow();
  if (!target) return;
  void target.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent("gumply:command", { detail: ${JSON.stringify(command)} }))`,
  );
}

// --- menu ----------------------------------------------------------------

async function openVaultFromMenu(kind: "open" | "create"): Promise<void> {
  const picked = kind === "open" ? await pickExistingVault() : await pickNewVault();
  if (picked) await openVault(picked);
}

function buildMenu(): void {
  const recent: MenuItemConstructorOptions[] = settings.recentVaults.map((path) => ({
    label: path,
    click: () => void openVault(path),
  }));
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    {
      label: tr("menu.file"),
      submenu: [
        { id: "new-page", label: tr("menu.newPage"), accelerator: "CmdOrCtrl+N", click: () => sendCommand("new.page") },
        { id: "new-whiteboard", label: tr("menu.newBoard"), accelerator: "CmdOrCtrl+Shift+N", click: () => sendCommand("new.board") },
        // N8: another window on the same vault.
        { id: "new-window", label: tr("menu.newWindow"), click: () => openAppWindow() },
        { type: "separator" },
        // B4: the in-app "Import from Notion…" dialog.
        { id: "import-notion", label: tr("menu.importNotion"), click: () => sendCommand("page.import-notion") },
        // G2: the open page as PDF (the web app's dialog, then printToPDF here).
        { id: "export-pdf", label: tr("menu.exportPdf"), click: () => sendCommand("page.export-pdf") },
        { type: "separator" },
        { id: "open-vault", label: tr("menu.openVault"), accelerator: "CmdOrCtrl+O", click: () => void openVaultFromMenu("open") },
        { label: tr("menu.createVault"), click: () => void openVaultFromMenu("create") },
        {
          label: tr("menu.openRecent"),
          submenu: [
            ...(recent.length > 0 ? recent : [{ label: tr("menu.noRecent"), enabled: false }]),
            { type: "separator" },
            {
              label: tr("menu.clearRecent"),
              enabled: recent.length > 0,
              click: () => {
                persist(withoutRecentVault(settings));
                buildMenu();
              },
            },
          ],
        },
        {
          label: tr("menu.revealVault"),
          enabled: vaultPath !== null,
          click: () => vaultPath && void shell.openPath(vaultPath),
        },
        { type: "separator" },
        { role: "quit", label: tr("menu.quit") },
      ],
    },
    // Roles get explicit labels: Electron's own are English-only.
    {
      label: tr("menu.edit"),
      submenu: [
        { role: "undo", label: tr("menu.undo") },
        { role: "redo", label: tr("menu.redo") },
        { type: "separator" },
        { role: "cut", label: tr("menu.cut") },
        { role: "copy", label: tr("menu.copy") },
        { role: "paste", label: tr("menu.paste") },
        ...(mac ? ([{ role: "pasteAndMatchStyle", label: tr("menu.pasteAndMatchStyle") }] as MenuItemConstructorOptions[]) : []),
        { role: "delete", label: tr("menu.delete") },
        { type: "separator" },
        { role: "selectAll", label: tr("menu.selectAll") },
      ],
    },
    {
      label: tr("menu.view"),
      submenu: [
        { id: "search", label: tr("menu.search"), accelerator: "CmdOrCtrl+K", click: () => sendCommand("view.search") },
        { type: "separator" },
        { role: "resetZoom", label: tr("menu.resetZoom") },
        { role: "zoomIn", label: tr("menu.zoomIn") },
        { role: "zoomOut", label: tr("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: tr("menu.fullScreen") },
        ...(isDev
          ? ([
              { type: "separator" },
              { role: "reload", label: tr("menu.reload") },
              { role: "toggleDevTools", label: tr("menu.devTools") },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: tr("menu.window"),
      submenu: [
        { role: "minimize", label: tr("menu.minimize") },
        ...(mac ? ([{ role: "zoom", label: tr("menu.zoom") }] as MenuItemConstructorOptions[]) : []),
        { role: "close", label: tr("menu.close") },
      ],
    },
    {
      role: "help",
      label: tr("menu.help"),
      submenu: [
        {
          // #6ka8s7mf: the guide on GitHub, in the app's language.
          id: "user-guide",
          label: tr("menu.userGuide"),
          click: () => void shell.openExternal(userGuideUrl(resolveDesktopLanguage(settings?.uiState[LANGUAGE_KEY], app.getLocale()))),
        },
        { type: "separator" },
        {
          id: "licences",
          label: tr("menu.licences"),
          click: () => {
            void shell.openPath(noticesPath()).then((error) => {
              if (error) void dialog.showMessageBox({ type: "error", message: tr("menu.licences"), detail: error });
            });
          },
        },
        ...(updates
          ? ([{ id: "check-updates", label: tr("menu.checkUpdates"), click: () => void checkForUpdatesNow() }] as MenuItemConstructorOptions[])
          : []),
        {
          id: "about",
          label: tr("menu.about"),
          click: () => void dialog.showMessageBox({ message: `Gumply ${app.getVersion()}`, detail: tr("about.detail") }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- auto-update (spec/auto-update, D42) ------------------------------------

function readResource(name: string): string | null {
  try {
    return readFileSync(join(process.resourcesPath, name), "utf8");
  } catch {
    return null;
  }
}

/** The updater, for installs that can update or be told about it. Never in `--mcp` mode. */
async function setUpUpdates(): Promise<void> {
  const kind = installKind({
    platform: process.platform,
    packaged: app.isPackaged,
    appImage: process.env.APPIMAGE,
    packageType: readResource("package-type"),
    hasUpdateConfig: app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml")),
  });
  if (kind === "none") return;
  // Loaded only here: development, unpacked and `--mcp` runs never load it.
  const { autoUpdater } = await import("electron-updater");
  let firstCheckDelayMs: number | undefined;
  // spec/auto-update §8, test builds only: scripts/build.mjs drops this labelled
  // block from every other build. A feed on 127.0.0.1 instead of GitHub, and a
  // sooner first check.
  TEST_FEED: {
    const feed = process.env.GUMPLY_UPDATE_FEED ?? "";
    if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(feed)) autoUpdater.setFeedURL({ provider: "generic", url: feed });
    const delay = Number(process.env.GUMPLY_UPDATE_FIRST_CHECK_MS);
    if (Number.isFinite(delay) && delay >= 0) firstCheckDelayMs = delay;
  }
  updates = new UpdateController({
    kind,
    currentVersion: app.getVersion(),
    updater: autoUpdater as unknown as UpdaterLike,
    load: () => settings.updates,
    save: (next) => persist({ ...settings, updates: next }),
    appImagePath: process.env.APPIMAGE,
    installDir: dirname(process.execPath),
    listProcesses: process.platform === "win32" ? () => listWindowsProcesses() : undefined,
    log: (message) => console.error(message),
    ...(firstCheckDelayMs !== undefined ? { firstCheckDelayMs } : {}),
    // The window's notice and Settings follow every change.
    // N8: every window shows the same update state.
    onChange: (state) => {
      for (const win of liveWindows()) {
        void win.webContents
          .executeJavaScript(`window.dispatchEvent(new CustomEvent("gumply:updates", { detail: ${JSON.stringify(state)} }))`)
          .catch(() => undefined);
      }
    },
  });
  updates.start();
  buildMenu();
}

/** The update controller as the in-process server's routes use it. */
function updatesForServer(controller: UpdateController): DesktopUpdates {
  return {
    get: () => controller.getState(),
    check: async () => {
      await controller.check(true);
      return controller.getState();
    },
    setMode: (mode) => controller.setMode(mode),
    restart: () => {
      restartAfterQuit = true;
      app.quit();
    },
  };
}

/** Help → Check for Updates…: check now and say what was found. */
async function checkForUpdatesNow(): Promise<void> {
  if (!updates) return;
  await updates.check(true);
  const state = updates.getState();
  const version = state.version ?? state.currentVersion;
  const show = (message: string, buttons: string[], detail?: string) => {
    const options = { type: "info" as const, message, buttons, defaultId: 0, cancelId: buttons.length - 1, ...(detail ? { detail } : {}) };
    const parent = activeWindow();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  };
  switch (state.status) {
    case "up-to-date":
      await show(tr("update.upToDate", { version: state.currentVersion }), [tr("update.ok")]);
      return;
    case "available": {
      const hint = state.kind === "deb" ? tr("update.debHint") : state.kind === "mac" ? tr("update.macHint") : undefined;
      const { response } = await show(tr("update.available", { version }), [tr("update.download"), tr("update.later")], hint);
      if (response === 0 && state.releaseUrl) void shell.openExternal(state.releaseUrl);
      return;
    }
    case "downloading":
      await show(tr("update.downloading", { version }), [tr("update.ok")]);
      return;
    case "ready": {
      const { response } = await show(tr("update.ready", { version }), [tr("update.restart"), tr("update.later")]);
      if (response === 0) {
        restartAfterQuit = true;
        app.quit();
      }
      return;
    }
    case "pending-running":
      await show(tr("update.pendingRunning"), [tr("update.ok")]);
      return;
    default:
      await show(tr("update.failed"), [tr("update.ok")]);
  }
}

/** At quit, after the flush: install a downloaded update if it's safe (D42). */
function installUpdateOnQuit(): void {
  if (!updates) return;
  const outcome = updates.installOnQuit(restartAfterQuit);
  // The AppImage was replaced in place: start it again if asked. (NSIS restarts itself with --force-run.)
  if (!restartAfterQuit) return;
  // The AppImage starts again from its file (its mount goes away with us);
  // NSIS starts the app itself after installing (--force-run).
  // app.relaunch starts it once this process has exited (the single-instance lock is free by then).
  if (updates.getState().kind === "appimage" && process.env.APPIMAGE) {
    app.relaunch({ execPath: process.env.APPIMAGE, args: [] });
  } else if (outcome !== "installed") {
    // Nothing installed (pending, failed): still start again, as asked.
    app.relaunch();
  }
}

// --- lifecycle ------------------------------------------------------------

/**
 * `Gumply --mcp --vault <path>` (A3, spec/mcp §1): the stdio MCP server, and
 * nothing else: no window, menu or tray, and no single-instance lock, so an
 * AI app can start it while the app is open. It exits when stdin closes.
 */
function runMcpMode(args: McpModeArgs): void {
  const exit = (code: number): never => {
    trace(`exit ${code}`);
    exitMcp(
      process.platform,
      {
        cleanup: () => {
          try {
            if (mcpThrowaway) rmSync(mcpThrowaway, { recursive: true, force: true });
            trace(mcpThrowaway ? "cleanup done" : "cleanup: nothing to remove");
          } catch (error) {
            trace(`cleanup left for the next start: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
            throw error;
          }
        },
        graceful: (status) => {
          trace("exit path: graceful (app.exit, process.exit)");
          app.exit(status);
          process.exit(status);
        },
        reallyExit: (status) => {
          const reallyExit = (process as unknown as { reallyExit?: (code: number) => void }).reallyExit;
          trace(`exit path: reallyExit${reallyExit ? "" : " (missing)"}`);
          reallyExit?.call(process, status);
        },
        killTree: () => {
          trace("exit path: taskkill /F /T (reallyExit returned)");
          spawnSync("taskkill", ["/F", "/T", "/PID", String(process.pid)], { stdio: "ignore", windowsHide: true });
        },
      },
      code,
    );
    return undefined as never;
  };
  if (process.platform === "darwin") app.dock?.hide();
  if (!args.vault) {
    process.stderr.write(`--vault is required.\n${MCP_MODE_USAGE}\n`);
    exit(2);
  }
  // #6bxm6ygf: the app's own version (stamped from the release tag), as /api/health and About show it.
  // #wfn2pdcx: in the packaged Windows exe (GUI subsystem) `process.stdin` is Node's
  // dummy stream (no handle): it never delivers the AI app's bytes and ends at once.
  // So on Windows the server reads and writes fds 0/1 directly. Elsewhere
  // `process.stdin`/`stdout` are real pipes.
  const stdio =
    process.platform === "win32"
      ? { stdin: createReadStream("", { fd: 0, autoClose: false }), stdout: createWriteStream("", { fd: 1, autoClose: false }) }
      : undefined;
  if (process.env.GUMPLY_MCP_TRACE) {
    trace(`served-on=${stdio ? "fd-streams" : "process.stdin/stdout"}`);
    // On the stdin the server actually reads (a second 'data' listener sees the same chunks).
    const served = stdio?.stdin ?? process.stdin;
    served.once("data", (chunk: Buffer | string) => trace(`stdin first ${chunk.length} bytes: ${JSON.stringify(String(chunk).slice(0, 120))}`));
    served.once("end", () => trace("stdin end"));
  }
  runMcp({ vault: resolve(args.vault!), readOnly: args.readOnly, exit, version: app.getVersion(), ...(stdio ? { stdio } : {}) });
}

if (mcpMode) {
  runMcpMode(mcpMode);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const target = activeWindow();
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
  });

  app.on("web-contents-created", (_event, contents) => {
    // No webviews, ever.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    launchPhase("app-ready");
    // Only clipboard writes (Copy buttons) are allowed; no camera, location…
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
    );
    // Tests only: never fetch a real dictionary (an unreachable URL; Chromium just keeps the list).
    if (process.env.GUMPLY_SPELLCHECK_DICTIONARY_URL) {
      session.defaultSession.setSpellCheckerDictionaryDownloadURL(process.env.GUMPLY_SPELLCHECK_DICTIONARY_URL);
    }
    applySpellcheckLanguages();

    // Board exports (spec/v0-6 §D) are browser downloads of blob URLs the app
    // made: they get the native Save dialog, starting in Downloads. Any other
    // download is refused.
    session.defaultSession.on("will-download", (event, item) => {
      const appOrigin = server ? new URL(server.url).origin : "";
      if (!isAppDownload(item.getURL(), appOrigin)) {
        event.preventDefault();
        return;
      }
      // G2: a page to print. It goes to a scratch folder, then printToPDF and the Save dialog.
      if (isPrintDownload(item.getFilename(), printToken)) {
        const scratchDir = mkdtempSync(join(tmpdir(), "gumply-print-"));
        const htmlPath = join(scratchDir, "page.html");
        const target = pdfName(item.getFilename(), printToken);
        item.setSavePath(htmlPath);
        item.once("done", (_doneEvent, state) => {
          if (state === "completed") void printToPdf(htmlPath, target, scratchDir).catch((error: unknown) => console.error("[gumply] PDF export failed:", error));
          else rmSync(scratchDir, { recursive: true, force: true });
        });
        return;
      }
      const name = suggestedName(item.getFilename());
      // Tests save without the dialog (it would wait for a click).
      const testDir = process.env.GUMPLY_DESKTOP_DOWNLOAD_DIR;
      if (testDir) item.setSavePath(join(resolve(testDir), name));
      else item.setSaveDialogOptions({ title: tr("export.saveTitle"), defaultPath: join(app.getPath("downloads"), name) });
    });

    settings = loadSettings(app.getPath("userData"));
    buildMenu();
    // Before the vault opens, so its server serves /api/desktop/updates.
    await setUpUpdates().catch((error: unknown) => console.error("[gumply] updates unavailable:", error));

    const fromEnv = process.env.GUMPLY_DESKTOP_VAULT;
    let vault: string | null = fromEnv ? resolve(fromEnv) : settings.lastVault;
    if (vault && !fromEnv && !isDirectory(vault)) {
      persist(withoutRecentVault(settings, vault));
      vault = null;
    }
    if (fromEnv) mkdirSync(vault!, { recursive: true });
    vault ??= await chooseFirstVault();
    if (!vault) {
      app.quit();
      return;
    }
    await openVault(vault);
  });

  app.on("window-all-closed", () => app.quit());

  let closing = false;
  app.on("before-quit", (event) => {
    if (closing || !server) return;
    event.preventDefault();
    closing = true;
    void (async () => {
      // Save the last edits while the server still runs (#3t6v62cb).
      if (!(await flushRenderer()) && !(await confirmUnsaved("quit"))) {
        closing = false;
        restartAfterQuit = false;
        return;
      }
      quitting = true;
      await server?.close().catch(() => undefined);
      server = null;
      installUpdateOnQuit();
      app.quit();
    })();
  });
}
