import { contextBridge, ipcRenderer } from "electron";

export type BackendStatus = "starting" | "running" | "stopped" | "error";

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  info?: { version: string; releaseNotes?: string };
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number };
  error?: string;
}

export interface HealthData {
  status: string;
  uptime: number;
  memoryMB: number;
}

contextBridge.exposeInMainWorld("openzigs", {
  isElectron: true,

  backend: {
    getStatus: (): Promise<BackendStatus> => ipcRenderer.invoke("backend:getStatus"),
    getPort: (): Promise<number | null> => ipcRenderer.invoke("backend:getPort"),
    getHealth: (): Promise<HealthData | null> => ipcRenderer.invoke("backend:getHealth"),
    start: (): Promise<void> => ipcRenderer.invoke("backend:start"),
    stop: (): Promise<void> => ipcRenderer.invoke("backend:stop"),
    onStatusChanged: (callback: (status: BackendStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: BackendStatus) =>
        callback(status);
      ipcRenderer.on("backend:statusChanged", handler);
      return () => ipcRenderer.removeListener("backend:statusChanged", handler);
    },
    onLog: (callback: (message: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) =>
        callback(message);
      ipcRenderer.on("backend:log", handler);
      return () => ipcRenderer.removeListener("backend:log", handler);
    },
  },

  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
    getPlatform: (): Promise<string> => ipcRenderer.invoke("app:getPlatform"),
  },

  update: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke("update:getState"),
    check: (): Promise<unknown> => ipcRenderer.invoke("update:check"),
    download: (): Promise<void> => ipcRenderer.invoke("update:download"),
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    setChannel: (channel: "stable" | "beta"): Promise<void> =>
      ipcRenderer.invoke("update:setChannel", channel),
    onStateChange: (callback: (state: UpdateState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) =>
        callback(state);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});
