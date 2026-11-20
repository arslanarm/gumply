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
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from "electron";
import { startGumplyServer, type RunningServer } from "../../server/src/start.js";
import {
  loadSettings,
  saveSettings,
  withOpenedVault,
  withoutRecentVault,
  type DesktopSettings,
  type WindowState,
} from "./settings.js";
import { classifyNavigation } from "./urls.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The built web app, copied next to this bundle by scripts/build.mjs. */
const WEB_ROOT = join(here, "web");
const isDev = !app.isPackaged;

// One settings folder in dev and packaged builds: ~/.config/Gumply on Linux
// (dev would otherwise use the package name, "@gumply/desktop").
app.setName("Gumply");
// Tests (and anyone who wants a separate profile) can move the settings.
if (process.env.GUMPLY_DESKTOP_USER_DATA) app.setPath("userData", resolve(process.env.GUMPLY_DESKTOP_USER_DATA));

let settings: DesktopSettings;
let server: RunningServer | null = null;
let vaultPath: string | null = null;
let window: BrowserWindow | null = null;

function persist(next: DesktopSettings): void {
  settings = next;
  try {
    saveSettings(app.getPath("userData"), settings);
  } catch (error) {
    console.error("[gumply-desktop] could not save settings:", error);
  }
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
    title: "Open a vault",
    message: "Choose the folder with your notes. Any Obsidian vault works.",
    buttonLabel: "Open vault",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
}

async function pickNewVault(): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: "Create a new vault",
    message: "Gumply keeps your notes as Markdown files in this folder.",
    buttonLabel: "Create vault",
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
      title: "Welcome to Gumply",
      message: "Where should Gumply keep your notes?",
      detail:
        "Your notes are plain Markdown files in a folder of your choice (a vault). You can open an existing folder, for example an Obsidian vault, or create a new one.",
      buttons: ["Open a folder…", "Create a new vault…", "Quit"],
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
    await dialog.showMessageBox({ type: "warning", message: "That folder doesn't exist anymore.", detail: target });
    persist(withoutRecentVault(settings, target));
    buildMenu();
    return;
  }
  const previous = server;
  server = null;
  if (previous) {
    // Save what the page still holds before switching.
    await flushRenderer();
    await previous.close();
  }

  server = await startGumplyServer({
    vaultPath: target,
    // A random free port; GUMPLY_DESKTOP_PORT pins one (tests, debugging).
    port: Number(process.env.GUMPLY_DESKTOP_PORT ?? 0) || 0,
    host: "127.0.0.1",
    seedDemo: true,
    webRoot: WEB_ROOT,
    log: (message) => console.log(message),
  });
  vaultPath = target;
  persist(withOpenedVault(settings, target));
  buildMenu();

  if (!window) createWindow();
  window!.setTitle(`Gumply — ${basename(target)}`);
  await window!.loadURL(`${server.url}/`);
}

async function flushRenderer(): Promise<void> {
  if (!window || window.isDestroyed()) return;
  // The editor saves on blur/visibility; give pending autosaves a moment.
  try {
    await window.webContents.executeJavaScript(
      "document.activeElement instanceof HTMLElement && document.activeElement.blur(); new Promise((r) => setTimeout(r, 800))",
    );
  } catch {
    // The page may be gone already.
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
  // The window title names the vault; the page's <title> doesn't replace it.
  window.on("page-title-updated", (event) => event.preventDefault());
  window.once("ready-to-show", () => window?.show());

  const contents = window.webContents;
  const appOrigin = () => (server ? new URL(server.url).origin : "");

  const handle = (url: string): boolean => {
    const action = classifyNavigation(url, appOrigin());
    if (action.kind === "app") return true;
    if (action.kind === "external") void shell.openExternal(action.url);
    else if (action.kind === "vault-file" && vaultPath) openVaultFile(action.path);
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
    return { action: "deny" };
  });

  const saveState = () => {
    if (!window || window.isDestroyed()) return;
    const maximized = window.isMaximized();
    const normal = window.getNormalBounds();
    persist({ ...settings, window: { x: normal.x, y: normal.y, width: normal.width, height: normal.height, maximized } });
  };
  window.on("close", saveState);
  window.on("closed", () => {
    window = null;
  });
}

function openVaultFile(path: string): void {
  if (!vaultPath) return;
  const absolute = resolve(vaultPath, path);
  if (!absolute.startsWith(`${vaultPath}${sep}`) || !existsSync(absolute)) return;
  void shell.openPath(absolute);
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
  const template: MenuItemConstructorOptions[] = [
    {
      label: "&File",
      submenu: [
        { id: "new-page", label: "New Page", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new-page") },
        { id: "new-whiteboard", label: "New Whiteboard", accelerator: "CmdOrCtrl+Shift+N", click: () => sendCommand("new-whiteboard") },
        { type: "separator" },
        { label: "Open Vault…", accelerator: "CmdOrCtrl+O", click: () => void openVaultFromMenu("open") },
        { label: "Create New Vault…", click: () => void openVaultFromMenu("create") },
        {
          label: "Open Recent",
          submenu: [
            ...(recent.length > 0 ? recent : [{ label: "No recent vaults", enabled: false }]),
            { type: "separator" },
            {
              label: "Clear Recent",
              enabled: recent.length > 0,
              click: () => {
                persist(withoutRecentVault(settings));
                buildMenu();
              },
            },
          ],
        },
        {
          label: "Reveal Vault in File Manager",
          enabled: vaultPath !== null,
          click: () => vaultPath && void shell.openPath(vaultPath),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "&View",
      submenu: [
        { id: "search", label: "Search", accelerator: "CmdOrCtrl+K", click: () => sendCommand("search") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(isDev ? ([{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "About Gumply", click: () => void dialog.showMessageBox({ message: `Gumply ${app.getVersion()}`, detail: "Notes as plain Markdown, with links, a graph and whiteboards." }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle ------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
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
    // Only clipboard writes (Copy buttons) are allowed; no camera, location…
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
    );

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
    void server.close().finally(() => {
      server = null;
      app.quit();
    });
  });
}
