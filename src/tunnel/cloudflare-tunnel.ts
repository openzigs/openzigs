import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "winston";

export type TunnelMode = "quick" | "named";

export type NamedTunnelConfig = {
  credentialsFile: string;
  hostname: string;
};

export type CloudflareTunnelOptions = {
  mode: TunnelMode;
  namedTunnel?: NamedTunnelConfig;
  spawn?: typeof nodeSpawn;
  logger?: Logger;
  connectTimeoutMs?: number;
  reconnectDelayMs?: number;
};

export class CloudflareTunnel extends EventEmitter {
  private process: ChildProcess | null = null;
  private publicUrl: string | null = null;
  private readonly spawn: typeof nodeSpawn;
  private readonly logger?: Logger;
  private readonly connectTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly mode: TunnelMode;
  private readonly namedTunnel?: NamedTunnelConfig;
  private stopping = false;
  private connectPromise: Promise<string> | null = null;
  private resolveConnect: ((url: string) => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private connectTimeoutId?: NodeJS.Timeout;
  private reconnectTimeoutId?: NodeJS.Timeout;
  private localUrl?: string;

  constructor(options: CloudflareTunnelOptions) {
    super();
    this.spawn = options.spawn ?? nodeSpawn;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.mode = options.mode;
    this.namedTunnel = options.namedTunnel;
  }

  getPublicUrl(): string | null {
    return this.publicUrl;
  }

  async start(localPort: number): Promise<string> {
    if (this.publicUrl) {
      return this.publicUrl;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.stopping = false;
    this.localUrl = `http://localhost:${localPort}`;
    this.connectPromise = new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });

    this.startProcess();
    return this.connectPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimeouts();

    if (this.process) {
      this.process.kill();
      this.process.removeAllListeners();
      this.process = null;
    }

    this.publicUrl = null;
    if (this.rejectConnect) {
      this.rejectConnect(new Error("Tunnel stopped"));
      this.resetConnectPromise();
    }
  }

  private startProcess(): void {
    if (!this.localUrl) {
      throw new Error("Local URL not set");
    }

    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = undefined;
    }

    const args = this.buildArgs(this.localUrl);
    this.process = this.spawn("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stderr = this.process.stderr;
    if (stderr) {
      stderr.on("data", (data) => {
        const output = data.toString();
        let newPublicUrl: string | null = null;

        if (this.mode === "quick") {
          const match = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
          if (match) {
            newPublicUrl = match[0];
          }
        } else if (this.mode === "named" && this.namedTunnel?.hostname) {
          if (/Registered tunnel connection/i.test(output) || /Connected/i.test(output)) {
            newPublicUrl = `https://${this.namedTunnel.hostname}`;
          }
        }

        if (newPublicUrl && !this.publicUrl) {
          this.publicUrl = newPublicUrl;
          this.emit("connected", this.publicUrl);

          if (this.resolveConnect) {
            this.resolveConnect(this.publicUrl);
            this.resetConnectPromise();
          } else if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = undefined;
          }
        }
      });
    }

    this.process.on("error", (error) => {
      if (this.stopping) {
        return;
      }
      if (this.rejectConnect) {
        this.rejectConnect(error instanceof Error ? error : new Error(String(error)));
        this.resetConnectPromise();
      } else {
        this.logger?.error(`Cloudflare tunnel process error: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect();
      }
    });

    this.process.on("exit", (code, signal) => {
      if (this.stopping) {
        return;
      }
      this.publicUrl = null;
      this.emit("disconnected");
      if (this.rejectConnect) {
        this.rejectConnect(new Error("Tunnel exited before connection was established"));
        this.resetConnectPromise();
      } else {
        this.logger?.warn(`Cloudflare tunnel process exited with code ${code} and signal ${signal}`);
        this.scheduleReconnect();
      }
    });

    this.connectTimeoutId = setTimeout(() => {
      if (this.stopping) {
        return;
      }
      if (this.rejectConnect) {
        this.rejectConnect(new Error("Tunnel timeout"));
        this.resetConnectPromise();
      } else {
        this.logger?.warn("Cloudflare tunnel reconnect attempt timed out, restarting process...");
        if (this.process) {
          this.process.kill();
        } else {
          this.scheduleReconnect();
        }
      }
    }, this.connectTimeoutMs);
  }

  private buildArgs(localUrl: string): string[] {
    const args = ["tunnel", "--url", localUrl];
    if (this.mode === "named") {
      if (!this.namedTunnel) {
        throw new Error("Named tunnel configuration is required");
      }
      args.push("--credentials-file", this.namedTunnel.credentialsFile);
      args.push("--hostname", this.namedTunnel.hostname);
    }
    return args;
  }

  private scheduleReconnect(): void {
    if (this.stopping) {
      return;
    }
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
    }
    this.reconnectTimeoutId = setTimeout(() => {
      if (this.stopping) {
        return;
      }
      this.logger?.warn("Cloudflare tunnel disconnected, attempting reconnect...");
      this.startProcess();
    }, this.reconnectDelayMs);
  }

  private clearTimeouts(): void {
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
    }
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
    }
    this.connectTimeoutId = undefined;
    this.reconnectTimeoutId = undefined;
  }

  private resetConnectPromise(): void {
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = undefined;
    }
  }
}
