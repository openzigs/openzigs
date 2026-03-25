import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { BrowserWindow } from "electron";
import EventEmitter from "node:events";

export type UpdateChannel = "stable" | "beta";

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  info?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

export class AutoUpdateManager extends EventEmitter {
  private state: UpdateState = { status: "idle" };
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

  constructor() {
    super();

    // Disable auto-download — user must confirm
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Use generic provider (GitHub Releases) — works without code signing
    autoUpdater.autoRunAppAfterInstall = true;

    this.wireEvents();
  }

  setChannel(channel: UpdateChannel): void {
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel === "beta";
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      this.updateState({ status: "checking" });
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateState({ status: "error", error: message });
      return null;
    }
  }

  async downloadUpdate(): Promise<void> {
    this.updateState({ status: "downloading" });
    await autoUpdater.downloadUpdate();
  }

  installUpdate(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  startPeriodicChecks(): void {
    this.stopPeriodicChecks();
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, this.CHECK_INTERVAL_MS);
  }

  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  destroy(): void {
    this.stopPeriodicChecks();
    this.removeAllListeners();
  }

  private wireEvents(): void {
    autoUpdater.on("checking-for-update", () => {
      this.updateState({ status: "checking" });
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.updateState({ status: "available", info });
    });

    autoUpdater.on("update-not-available", () => {
      this.updateState({ status: "idle" });
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.updateState({ status: "downloading", progress });
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.updateState({ status: "downloaded", info });
    });

    autoUpdater.on("error", (err: Error) => {
      this.updateState({ status: "error", error: err.message });
    });
  }

  private updateState(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial };
    this.emit("state-change", this.getState());
    // Forward to all browser windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("update:state", this.getState());
    }
  }
}

/**
 * Convenience factory used by main.ts.
 * Checks for updates on startup and starts periodic checks.
 */
export function setupUpdater(): AutoUpdateManager {
  const manager = new AutoUpdateManager();

  // Default to stable channel
  manager.setChannel("stable");

  // Check on startup (delayed to avoid blocking app launch)
  setTimeout(() => {
    manager.checkForUpdates();
  }, 10_000);

  // Start periodic checks (every 4 hours)
  manager.startPeriodicChecks();

  return manager;
}
