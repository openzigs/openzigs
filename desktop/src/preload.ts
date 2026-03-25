import { contextBridge, ipcRenderer } from "electron";

export type BackendStatus = "starting" | "running" | "stopped" | "error";

contextBridge.exposeInMainWorld("openzigs", {
  backend: {
    getStatus: (): Promise<BackendStatus> => ipcRenderer.invoke("backend:getStatus"),
    getPort: (): Promise<number | null> => ipcRenderer.invoke("backend:getPort"),
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
});
