import { Tray, Menu, nativeImage } from "electron";
import type { BackendStatus } from "./backend.js";

export interface TrayManagerOptions {
  onShowWindow: () => void;
  onStartServer: () => void;
  onStopServer: () => void;
  onQuit: () => void;
}

// Simple 16x16 colored circle icons as base64 data URLs
const ICON_GREEN =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4T2Nk+M/wn4EBBJgYkAETAwMDI7oCrAJYNMC4yC7ArwGXy0BuwOUqnC4jxg2kuYGh4j0DAOZ4FRGS+xf4AAAAAElFTkSuQmCC";
const ICON_RED =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVQ4T2P8z/D/PwMDA4gAA5MBiGBiYGBg/I+ugIGBgYERVQtWAWwaYFxkFxDQgMtlOF1GjBtIdwMANHoVEX6OlhEAAAAASUVORK5CYII=";
const ICON_YELLOW =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVQ4T2P8z/D/PwMDA4gAA5MBE4hwYmBgYPyProCBgYERVQtWAWwaYFxkFxDQgMtlOF1GjBtIdwMA//sVEdyaJJkAAAAASUVORK5CYII=";

export class TrayManager {
  private tray: Tray | null = null;
  private currentStatus: BackendStatus = "stopped";
  private readonly callbacks: TrayManagerOptions;

  constructor(options: TrayManagerOptions) {
    this.callbacks = options;
    this.createTray();
  }

  updateStatus(status: BackendStatus): void {
    this.currentStatus = status;
    this.updateTrayIcon();
    this.updateContextMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private createTray(): void {
    const icon = this.getIcon("stopped");
    if (process.platform === "darwin") {
      icon.setTemplateImage(true);
    }
    this.tray = new Tray(icon);
    this.tray.setToolTip("OpenZigs");

    // Double-click to show window (Windows/Linux)
    this.tray.on("double-click", () => {
      this.callbacks.onShowWindow();
    });

    this.updateContextMenu();
  }

  private getIcon(status: BackendStatus): Electron.NativeImage {
    switch (status) {
      case "running":
        return nativeImage.createFromDataURL(ICON_GREEN);
      case "starting":
        return nativeImage.createFromDataURL(ICON_YELLOW);
      case "stopped":
      case "error":
        return nativeImage.createFromDataURL(ICON_RED);
    }
  }

  private updateTrayIcon(): void {
    if (!this.tray) return;
    const icon = this.getIcon(this.currentStatus);
    if (process.platform === "darwin") {
      icon.setTemplateImage(true);
    }
    this.tray.setImage(icon);
    this.tray.setToolTip(`OpenZigs — ${this.currentStatus}`);
  }

  private updateContextMenu(): void {
    if (!this.tray) return;
    const isRunning = this.currentStatus === "running";
    const isStarting = this.currentStatus === "starting";

    const menu = Menu.buildFromTemplate([
      {
        label: `Status: ${this.currentStatus}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Window",
        click: () => this.callbacks.onShowWindow(),
      },
      { type: "separator" },
      {
        label: "Start Server",
        enabled: !isRunning && !isStarting,
        click: () => this.callbacks.onStartServer(),
      },
      {
        label: "Stop Server",
        enabled: isRunning,
        click: () => this.callbacks.onStopServer(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => this.callbacks.onQuit(),
      },
    ]);

    this.tray.setContextMenu(menu);
  }
}
