import { ipcMain } from "electron";
import type { BackendManager } from "./backend.js";
import type { WindowManager } from "./window.js";

export interface IpcBridgeOptions {
  backendManager: BackendManager;
  windowManager: WindowManager;
}

export class IpcBridge {
  private readonly backendManager: BackendManager;
  private readonly windowManager: WindowManager;

  constructor(options: IpcBridgeOptions) {
    this.backendManager = options.backendManager;
    this.windowManager = options.windowManager;
  }

  register(): void {
    // Renderer can query backend status
    ipcMain.handle("backend:getStatus", () => {
      return this.backendManager.getStatus();
    });

    // Renderer can query backend port
    ipcMain.handle("backend:getPort", () => {
      return this.backendManager.getPort();
    });

    // Renderer can request backend start/stop
    ipcMain.handle("backend:start", async () => {
      await this.backendManager.start();
    });

    ipcMain.handle("backend:stop", () => {
      this.backendManager.stop();
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
  }
}
