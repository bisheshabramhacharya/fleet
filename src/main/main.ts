import path from "node:path";
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, shell, Tray } from "electron";
import { FleetNode, type SecretBox } from "../node/fleet.ts";
import { startServer, type RunningServer } from "../hub/server.ts";

const startHidden = process.argv.includes("--hidden");
let node: FleetNode | null = null;
let server: RunningServer | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const secrets: SecretBox = {
  get available() {
    return safeStorage.isEncryptionAvailable();
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
};

function asset(name: string): string {
  return path.join(__dirname, "assets", name);
}

function dashboardUrl(): string {
  return `http://127.0.0.1:${server?.port ?? 8742}/`;
}

function showWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: "fleet",
    backgroundColor: "#0b0b0c",
    autoHideMenuBar: true,
    icon: asset("icon.png"),
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  void window.loadURL(dashboardUrl());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("close", (event) => {
    // Closing the window keeps the collector running in the tray.
    if (!quitting) {
      event.preventDefault();
      window?.hide();
      if (process.platform === "darwin") app.dock?.hide();
    }
  });
  if (process.platform === "darwin") void app.dock?.show();
}

function applyLoginItem() {
  if (!node) return;
  app.setLoginItemSettings({ openAtLogin: node.config.value.openAtLogin, args: ["--hidden"] });
}

function buildTray() {
  const file = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const image = nativeImage.createFromPath(asset(file));
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(asset("icon.png")).resize({ width: 16, height: 16 }) : image);
  tray.setToolTip("fleet");
  const refresh = () => {
    const sync = node?.syncStatus;
    const role = node?.role === "hub" ? "Hub" : "Collector";
    const status = node?.role === "collector" ? (sync?.lastError ? `Not syncing: ${sync.lastError}` : sync?.lastPushAt ? "Synced with hub" : "Waiting for first sync") : "Collecting this device";
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `fleet ${app.getVersion()} · ${role}`, enabled: false },
        { label: status.slice(0, 70), enabled: false },
        { type: "separator" },
        { label: "Open dashboard", click: showWindow },
        { label: "Scan now", click: () => void node?.cycle().finally(refresh) },
        {
          label: "Open at login",
          type: "checkbox",
          checked: node?.config.value.openAtLogin ?? true,
          click: async (item) => {
            await node?.config.update({ openAtLogin: item.checked });
            applyLoginItem();
          },
        },
        { type: "separator" },
        { label: "Quit fleet", click: () => app.quit() },
      ]),
    );
  };
  refresh();
  tray.on("click", showWindow);
  setInterval(refresh, 30_000).unref();
}

async function boot() {
  node = await FleetNode.open({
    dataDir: app.getPath("userData"),
    secrets,
    log: (m) => console.log(`[fleet] ${m}`),
  });
  try {
    server = await startServer({ node, uiDir: path.join(__dirname, "ui") });
  } catch (error) {
    dialog.showErrorBox(
      "fleet could not start",
      `Port ${node.config.value.port} is busy. Is another copy of fleet running?\n\n${String(error)}`,
    );
    app.exit(1);
    return;
  }
  node.start();
  applyLoginItem();
  buildTray();
  if (!startHidden) showWindow();
  else if (process.platform === "darwin") app.dock?.hide();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", (event) => {
    if (!node) return;
    event.preventDefault();
    const n = node;
    node = null;
    void Promise.allSettled([n.stop(), server?.close()]).finally(() => app.exit(0));
  });
  // Keep running in the tray when every window is closed.
  app.on("window-all-closed", () => undefined);
  app.setAppUserModelId("dev.bishesha.fleet");
  void app.whenReady().then(boot);
}
