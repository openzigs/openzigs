import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock electron modules before importing the module under test
vi.mock("electron-updater", () => {
  const EventEmitter = require("node:events");
  const emitter = new EventEmitter();
  return {
    autoUpdater: Object.assign(emitter, {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: false,
      allowPrerelease: false,
      channel: "latest",
      checkForUpdates: vi.fn().mockResolvedValue({
        updateInfo: { version: "1.0.0", releaseNotes: "test" },
      }),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      quitAndInstall: vi.fn(),
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Import after mocks are set up
const { AutoUpdateManager } = await import("./updater.js");
const { autoUpdater } = await import("electron-updater");

describe("AutoUpdateManager", () => {
  let manager: InstanceType<typeof AutoUpdateManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AutoUpdateManager();
  });

  it("initializes with idle state", () => {
    const state = manager.getState();
    expect(state.status).toBe("idle");
  });

  it("disables auto-download", () => {
    expect(autoUpdater.autoDownload).toBe(false);
  });

  it("sets channel to stable by default", () => {
    manager.setChannel("stable");
    expect(autoUpdater.channel).toBe("stable");
    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it("sets channel to beta with prerelease enabled", () => {
    manager.setChannel("beta");
    expect(autoUpdater.channel).toBe("beta");
    expect(autoUpdater.allowPrerelease).toBe(true);
  });

  it("checkForUpdates returns update info", async () => {
    const info = await manager.checkForUpdates();
    expect(info).toEqual({ version: "1.0.0", releaseNotes: "test" });
  });

  it("emits state-change events", async () => {
    const states: string[] = [];
    manager.on("state-change", (state: { status: string }) => {
      states.push(state.status);
    });
    await manager.checkForUpdates();
    expect(states).toContain("checking");
  });

  it("handles check errors gracefully", async () => {
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(
      new Error("Network error")
    );
    const result = await manager.checkForUpdates();
    expect(result).toBeNull();
    expect(manager.getState().status).toBe("error");
    expect(manager.getState().error).toBe("Network error");
  });

  it("starts and stops periodic checks", () => {
    manager.startPeriodicChecks();
    // Should not throw
    manager.stopPeriodicChecks();
  });

  it("destroy cleans up", () => {
    manager.startPeriodicChecks();
    manager.destroy();
    expect(manager.listenerCount("state-change")).toBe(0);
  });
});
