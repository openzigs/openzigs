import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import http from "node:http";

export type BackendStatus = "starting" | "running" | "stopped" | "error";

export interface HealthData {
  status: string;
  uptime: number;
  memoryMB: number;
}

export interface BackendManagerOptions {
  isDev: boolean;
  backendPath: string;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export class BackendManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private status: BackendStatus = "stopped";
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private lastHealthData: HealthData | null = null;
  private readonly isDev: boolean;
  private readonly backendPath: string;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly startupTimeoutMs: number;

  constructor(options: BackendManagerOptions) {
    super();
    this.isDev = options.isDev;
    this.backendPath = options.backendPath;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 5000;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 3000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30000;
  }

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") return;

    this.setStatus("starting");

    if (this.isDev) {
      // In dev mode, assume the backend is already running externally
      this.port = Number(process.env.OPENZIGS_PORT) || 3000;
      const alive = await this.checkHealth(this.port);
      if (alive) {
        this.setStatus("running");
        this.startHealthPolling();
        return;
      }
      // If not running, we'll spawn it
    }

    try {
      this.port = await this.findFreePort();
      const env = {
        ...process.env,
        PORT: String(this.port),
        NODE_ENV: this.isDev ? "development" : "production",
      };

      this.child = spawn(process.execPath, [this.backendPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.child.stdout?.on("data", (data: Buffer) => {
        this.emit("log", data.toString());
      });

      this.child.stderr?.on("data", (data: Buffer) => {
        this.emit("log", data.toString());
      });

      this.child.on("exit", (code, signal) => {
        this.emit("log", `Backend exited: code=${code} signal=${signal}`);
        this.child = null;
        if (this.status !== "stopped") {
          this.setStatus("error");
        }
      });

      this.child.on("error", (err) => {
        this.emit("log", `Backend spawn error: ${err.message}`);
        this.setStatus("error");
      });

      // Wait for backend to be ready
      await this.waitForReady();
      this.setStatus("running");
      this.startHealthPolling();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", `Backend start failed: ${msg}`);
      this.setStatus("error");
    }
  }

  stop(): void {
    this.stopHealthPolling();
    if (this.child) {
      this.child.kill("SIGTERM");
      // Force kill after 5s if still alive
      const forceKillTimer = setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
      }, 5000);
      this.child.on("exit", () => clearTimeout(forceKillTimer));
      this.child = null;
    }
    this.lastHealthData = null;
    this.setStatus("stopped");
  }

  getPort(): number | null {
    return this.port;
  }

  getStatus(): BackendStatus {
    return this.status;
  }

  getHealthData(): HealthData | null {
    return this.lastHealthData;
  }

  private setStatus(status: BackendStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < this.startupTimeoutMs) {
      if (this.port && (await this.checkHealth(this.port))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Backend did not become ready within ${this.startupTimeoutMs}ms`);
  }

  async checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${port}/health`,
        { timeout: this.healthCheckTimeoutMs },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(body) as Record<string, unknown>;
              if (json.status === "ok") {
                this.lastHealthData = {
                  status: String(json.status),
                  uptime: typeof json.uptime === "number" ? json.uptime : 0,
                  memoryMB: typeof json.memoryMB === "number" ? json.memoryMB : 0,
                };
                resolve(true);
              } else {
                resolve(false);
              }
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    this.healthInterval = setInterval(async () => {
      if (!this.port) return;
      const alive = await this.checkHealth(this.port);
      if (!alive && this.status === "running") {
        this.setStatus("error");
      } else if (alive && this.status === "error") {
        this.setStatus("running");
      }
    }, this.healthCheckIntervalMs);
  }

  private stopHealthPolling(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Could not determine free port")));
        }
      });
      server.on("error", reject);
    });
  }
}
