import { BrowserWindow, screen, app } from "electron";
import path from "node:path";
import fs from "node:fs";

export interface WindowManagerOptions {
  isDev: boolean;
}

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const WINDOW_STATE_FILE = "window-state.json";

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private forceQuit = false;
  private readonly isDev: boolean;

  constructor(options: WindowManagerOptions) {
    this.isDev = options.isDev;
  }

  async createWindow(port: number | null): Promise<BrowserWindow> {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.focus();
      return this.mainWindow;
    }

    const savedBounds = this.loadWindowState();
    const defaults = { width: 1280, height: 800 };

    this.mainWindow = new BrowserWindow({
      width: savedBounds?.width ?? defaults.width,
      height: savedBounds?.height ?? defaults.height,
      x: savedBounds?.x,
      y: savedBounds?.y,
      minWidth: 800,
      minHeight: 600,
      title: "OpenZigs",
      webPreferences: {
        preload: path.join(import.meta.dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      show: false, // Show after ready-to-show
    });

    if (savedBounds?.isMaximized) {
      this.mainWindow.maximize();
    }

    // Show window once content is loaded to avoid blank flash
    this.mainWindow.once("ready-to-show", () => {
      this.mainWindow?.show();
    });

    // Close to tray instead of quitting
    this.mainWindow.on("close", (event) => {
      if (!this.forceQuit) {
        event.preventDefault();
        this.mainWindow?.hide();
        // On macOS, also hide from dock when window is hidden
        if (process.platform === "darwin") {
          app.dock?.hide();
        }
      }
    });

    // Save window bounds on move/resize
    this.mainWindow.on("resize", () => this.saveWindowState());
    this.mainWindow.on("move", () => this.saveWindowState());

    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });

    // Load the app
    const url = this.isDev
      ? `http://localhost:3001`
      : `http://127.0.0.1:${port}`;

    await this.mainWindow.loadURL(url);

    if (this.isDev) {
      this.mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    return this.mainWindow;
  }

  showAndFocus(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    // On macOS, show dock icon when window is shown
    if (process.platform === "darwin") {
      app.dock?.show();
    }
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  setForceQuit(force: boolean): void {
    this.forceQuit = force;
  }

  getWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  private getStateFilePath(): string {
    return path.join(app.getPath("userData"), WINDOW_STATE_FILE);
  }

  private loadWindowState(): WindowBounds | null {
    try {
      const data = fs.readFileSync(this.getStateFilePath(), "utf-8");
      const state = JSON.parse(data) as WindowBounds;
      // Validate the saved position is still within a visible display
      const displays = screen.getAllDisplays();
      const inBounds = displays.some((display) => {
        const { x, y, width, height } = display.bounds;
        return (
          state.x >= x &&
          state.y >= y &&
          state.x < x + width &&
          state.y < y + height
        );
      });
      return inBounds ? state : null;
    } catch {
      return null;
    }
  }

  private saveWindowState(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const bounds = this.mainWindow.getBounds();
    const state: WindowBounds = {
      ...bounds,
      isMaximized: this.mainWindow.isMaximized(),
    };
    try {
      fs.writeFileSync(this.getStateFilePath(), JSON.stringify(state));
    } catch {
      // ignore write failures
    }
  }
}
