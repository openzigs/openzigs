import { app, BrowserWindow } from "electron";
import path from "node:path";
import { BackendManager } from "./backend.js";
import { WindowManager } from "./window.js";
import { TrayManager } from "./tray.js";
import { IpcBridge } from "./ipc.js";
import { setupUpdater } from "./updater.js";

const isDev = !app.isPackaged;

let backendManager: BackendManager;
let windowManager: WindowManager;
let trayManager: TrayManager;
let ipcBridge: IpcBridge;

// Single instance lock — prevent multiple app instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    windowManager?.showAndFocus();
  });
}

app.whenReady().then(async () => {
  // Initialize backend manager
  backendManager = new BackendManager({
    isDev,
    backendPath: isDev
      ? path.resolve(import.meta.dirname, "..", "..", "dist", "server.js")
      : path.join(process.resourcesPath, "backend", "server.js"),
  });

  // Initialize window manager
  windowManager = new WindowManager({ isDev });

  // Initialize tray
  trayManager = new TrayManager({
    onShowWindow: () => windowManager.showAndFocus(),
    onStartServer: () => backendManager.start(),
    onStopServer: () => backendManager.stop(),
    onQuit: () => {
      backendManager.stop();
      app.quit();
    },
  });

  // Initialize IPC bridge
  ipcBridge = new IpcBridge({
    backendManager,
    windowManager,
  });
  ipcBridge.register();

  // Wire backend status changes to tray
  backendManager.on("status", (status) => {
    trayManager.updateStatus(status);
  });

  // Start backend
  await backendManager.start();

  // Create & show main window once backend is ready
  const port = backendManager.getPort();
  await windowManager.createWindow(port);

  // Setup auto-updater (stub for now)
  setupUpdater();
});

// macOS: re-create window when dock icon clicked and no windows open
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const port = backendManager?.getPort();
    if (port) {
      windowManager?.createWindow(port);
    }
  }
});

// Prevent app from quitting when all windows are closed (tray keeps it alive)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // On Windows/Linux keep running in tray — don't quit
  }
});

app.on("before-quit", () => {
  windowManager?.setForceQuit(true);
  backendManager?.stop();
});
