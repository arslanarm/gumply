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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from "electron";
import { startGumplyServer, type RunningServer } from "../../server/src/start.js";
import { applyUiStateChange, type UiState, type UiStateChange, type UiStateStore } from "../../server/src/ui-state.js";
import {
  loadSettings,
  saveSettings,
  withOpenedVault,
  withoutRecentVault,
  type DesktopSettings,
  type WindowState,
} from "./settings.js";
import { isAppDownload, suggestedName } from "./downloads.js";
import { describeFlush, flushSaved, NO_ANSWER } from "./flush-report.js";
import { desktopT, resolveDesktopLanguage } from "./i18n.js";
import { classifyNavigation, vaultFileAction } from "./urls.js";
import { MCP_MODE_USAGE, mcpLaunchCommand, mcpModeArgs, type McpModeArgs } from "./mcp-mode.js";
import { runMcp } from "../../mcp/src/run.js";

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

// One settings folder in dev and packaged builds: ~/.config/Gumply on Linux
// (dev would otherwise use the package name, "@gumply/desktop").
app.setName("Gumply");
// Tests (and anyone who wants a separate profile) can move the settings.
if (process.env.GUMPLY_DESKTOP_USER_DATA) app.setPath("userData", resolve(process.env.GUMPLY_DESKTOP_USER_DATA));

/**
 * A3: `--mcp` launches never touch the app's settings folder (recent vaults,
 * window state). Chromium still keeps some state of its own (Local State,
 * GPU cache, crash reports): it goes to a throwaway folder, removed on exit.
 */
const mcpMode = mcpModeArgs(process.argv);
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

let settings: DesktopSettings;
let server: RunningServer | null = null;
let vaultPath: string | null = null;
let window: BrowserWindow | null = null;
/** Set once the pages are flushed and the app may really quit (#3t6v62cb). */
let quitting = false;

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

// A new interface language in the app: the menu follows it (#7h5utv23).
onUiStateChange((change) => {
  if (change.set?.[LANGUAGE_KEY] !== undefined || change.remove?.includes(LANGUAGE_KEY)) buildMenu();
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
    // A3: Settings → MCP shows AI apps how to start this app's --mcp mode.
    mcpCommand: mcpLaunchCommand(process.execPath, app.isPackaged, app.getAppPath()),
    log: (message) => console.log(message),
  });
  launchPhase("server-started");
  vaultPath = target;
  persist(withOpenedVault(settings, target));
  buildMenu();

  themeForFirstPaint();
  if (!window) {
    createWindow();
    launchPhase("window-created");
  }
  try {
    await window!.loadURL(`${server.url}/`);
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

async function flushRenderer(): Promise<boolean> {
  if (!window || window.isDestroyed()) return true;
  try {
    const result: unknown = await Promise.race([
      window.webContents.executeJavaScript(
        "window.__gumplyFlush ? window.__gumplyFlush() : (document.activeElement instanceof HTMLElement && document.activeElement.blur(), new Promise((r) => setTimeout(() => r(true), 800)))",
      ),
      new Promise((resolve) => setTimeout(() => resolve(NO_ANSWER), FLUSH_WAIT_MS)),
    ]);
    // Why the dialog will show (#ms44vnit): logged, and readable by the tests.
    unsavedDialog.reason = describeFlush(result, FLUSH_WAIT_MS);
    if (unsavedDialog.reason) console.warn(`Not everything is saved: ${unsavedDialog.reason}`);
    return flushSaved(result);
  } catch {
    return true; // the page is gone already: nothing left to save
  }
}

/**
 * Whether the "couldn't be saved" dialog is up, and why the last flush
 * wasn't complete. Readable from the main process
 * (`globalThis.__gumplyUnsavedDialog`) so a test that waits for the app to
 * quit can say why it didn't, instead of timing out blind.
 */
const unsavedDialog: { open: boolean; reason: string | null } = { open: false, reason: null };
(globalThis as { __gumplyUnsavedDialog?: typeof unsavedDialog }).__gumplyUnsavedDialog = unsavedDialog;

/** The flush failed: ask before losing those edits. */
async function confirmUnsaved(action: "switchVaults" | "close" | "quit"): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: [tr(`unsaved.${action}`), tr("unsaved.cancel")],
    defaultId: 1,
    cancelId: 1,
    message: tr("unsaved.message"),
    detail: tr("unsaved.detail"),
  };
  unsavedDialog.open = true;
  try {
    const { response } =
      window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
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

function createWindow(): void {
  const bounds = initialBounds();
  window = new BrowserWindow({
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
  if (settings.window?.maximized) window.maximize();
  // The window title is the page's own `document.title` (the web app names
  // the page and the vault, #ux5cukze).
  window.once("ready-to-show", () => window?.show());

  const contents = window.webContents;
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
    // New windows are never created; links are handed to the system.
    const action = classifyNavigation(url, appOrigin());
    if (action.kind === "external") void shell.openExternal(action.url);
    else if (action.kind === "vault-file" && vaultPath) openVaultFile(action.path);
    else if (action.kind === "trash-reveal" && vaultPath) revealTrashed(action.trashId);
    return { action: "deny" };
  });

  const saveState = () => {
    if (!window || window.isDestroyed()) return;
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
      if (!(await flushRenderer()) && !(await confirmUnsaved("close"))) return;
      closeReady = true;
      window?.close();
    })();
  });
  // The page asks to stay ("Leave site?", only when a save can't go out):
  // Electron would just cancel the close silently, so ask natively.
  contents.on("will-prevent-unload", (event) => {
    const target = window && !window.isDestroyed() ? window : null;
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
    window = null;
  });
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

function sendCommand(command: "new-page" | "new-whiteboard" | "search"): void {
  if (!window || window.isDestroyed()) return;
  void window.webContents.executeJavaScript(
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
        { id: "new-page", label: tr("menu.newPage"), accelerator: "CmdOrCtrl+N", click: () => sendCommand("new-page") },
        { id: "new-whiteboard", label: tr("menu.newBoard"), accelerator: "CmdOrCtrl+Shift+N", click: () => sendCommand("new-whiteboard") },
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
        { id: "search", label: tr("menu.search"), accelerator: "CmdOrCtrl+K", click: () => sendCommand("search") },
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
          id: "about",
          label: tr("menu.about"),
          click: () => void dialog.showMessageBox({ message: `Gumply ${app.getVersion()}`, detail: tr("about.detail") }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle ------------------------------------------------------------

/**
 * `Gumply --mcp --vault <path>` (A3, spec/mcp §1): the stdio MCP server, and
 * nothing else: no window, menu or tray, and no single-instance lock, so an
 * AI app can start it while the app is open. It exits when stdin closes.
 */
function runMcpMode(args: McpModeArgs): void {
  const exit = (code: number): never => {
    if (mcpThrowaway) rmSync(mcpThrowaway, { recursive: true, force: true });
    app.exit(code);
    process.exit(code);
  };
  if (process.platform === "darwin") app.dock?.hide();
  if (!args.vault) {
    process.stderr.write(`--vault is required.\n${MCP_MODE_USAGE}\n`);
    exit(2);
  }
  runMcp({ vault: resolve(args.vault!), readOnly: args.readOnly, exit });
}

if (mcpMode) {
  runMcpMode(mcpMode);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
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

    // Board exports (spec/v0-6 §D) are browser downloads of blob URLs the app
    // made: they get the native Save dialog, starting in Downloads. Any other
    // download is refused.
    session.defaultSession.on("will-download", (event, item) => {
      const appOrigin = server ? new URL(server.url).origin : "";
      if (!isAppDownload(item.getURL(), appOrigin)) {
        event.preventDefault();
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
        return;
      }
      quitting = true;
      await server?.close().catch(() => undefined);
      server = null;
      app.quit();
    })();
  });
}
