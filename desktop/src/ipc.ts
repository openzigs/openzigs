import { ipcMain, app } from "electron";
import type { BackendManager } from "./backend.js";
import type { WindowManager } from "./window.js";
import type { AutoUpdateManager, UpdateChannel } from "./updater.js";

export interface IpcBridgeOptions {
  backendManager: BackendManager;
  windowManager: WindowManager;
  updateManager?: AutoUpdateManager;
}

export class IpcBridge {
  private readonly backendManager: BackendManager;
  private readonly windowManager: WindowManager;
  private updateManager?: AutoUpdateManager;

  constructor(options: IpcBridgeOptions) {
    this.backendManager = options.backendManager;
    this.windowManager = options.windowManager;
    this.updateManager = options.updateManager;
  }

  setUpdateManager(manager: AutoUpdateManager): void {
    this.updateManager = manager;
  }

  register(): void {
    // ── Backend ────────────────────────────────────────────

    ipcMain.handle("backend:getStatus", () => {
      return this.backendManager.getStatus();
    });

    ipcMain.handle("backend:getPort", () => {
      return this.backendManager.getPort();
    });

    ipcMain.handle("backend:start", async () => {
      await this.backendManager.start();
    });

    ipcMain.handle("backend:stop", () => {
      this.backendManager.stop();
    });

    ipcMain.handle("backend:getHealth", () => {
      return this.backendManager.getHealthData();
    });

    // Forward status changes to renderer
    this.backendManager.on("status", (status) => {
      const win = this.windowManager.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("backend:statusChanged", status);
      }
    });

    // Forward backend logs to renderer
    this.backendManager.on("log", (message) => {
      const win = this.windowManager.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("backend:log", message);
      }
    });

    // ── App info ───────────────────────────────────────────

    ipcMain.handle("app:getVersion", () => app.getVersion());
    ipcMain.handle("app:getPlatform", () => process.platform);

    // ── Updates ────────────────────────────────────────────

    ipcMain.handle("update:getState", () => {
      return this.updateManager?.getState() ?? { status: "idle" };
    });

    ipcMain.handle("update:check", async () => {
      return (await this.updateManager?.checkForUpdates()) ?? null;
    });

    ipcMain.handle("update:download", async () => {
      await this.updateManager?.downloadUpdate();
    });

    ipcMain.handle("update:install", () => {
      this.updateManager?.installUpdate();
    });

    ipcMain.handle("update:setChannel", (_event, channel: UpdateChannel) => {
      this.updateManager?.setChannel(channel);
    });
  }
}
