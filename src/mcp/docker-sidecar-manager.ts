import Docker from "dockerode";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logging/logger.js";

/**
 * Resolve the Docker socket path for the current platform.
 * macOS Docker Desktop uses ~/.docker/run/docker.sock instead of /var/run/docker.sock.
 */
function resolveDockerSocketPath(): string {
  const candidates = [
    "/var/run/docker.sock",
    path.join(os.homedir(), ".docker", "run", "docker.sock"),
    path.join(
      os.homedir(),
      "Library",
      "Containers",
      "com.docker.docker",
      "Data",
      "docker.raw.sock"
    ),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // Not accessible, try next
    }
  }

  // Fallback to default
  return "/var/run/docker.sock";
}

// ── Sidecar Definition ──────────────────────────────────────────────────────

export type SidecarDefinition = {
  /** Unique key, e.g. "linkedin", "twitter" */
  name: string;
  /** Docker image reference */
  image: string;
  /** Container name (must be unique per Docker host) */
  containerName: string;
  /** Port mapping: host → container */
  ports: { host: number; container: number };
  /** Environment variables injected into the container */
  env: Record<string, string>;
  /** Docker network to attach to */
  network: string;
  /** Extra volume mounts (host:container) */
  volumes?: string[];
  /** Environment variable names that must be non-empty for this sidecar to start */
  requiredEnvVars?: string[];
  /** HTTP path for health-check probe (default: /health) */
  healthCheckPath?: string;
  /** Timeout in ms for the health probe (default: 5000) */
  healthCheckTimeout?: number;
};

export type SidecarStatus = {
  name: string;
  containerName: string;
  running: boolean;
  healthy: boolean;
  containerId?: string;
  url: string;
  error?: string;
};

type SidecarManagerEvents = {
  "sidecar:started": (status: SidecarStatus) => void;
  "sidecar:stopped": (status: SidecarStatus) => void;
  "sidecar:healthy": (status: SidecarStatus) => void;
  "sidecar:unhealthy": (status: SidecarStatus) => void;
  "sidecar:error": (name: string, error: Error) => void;
};

// ── Default sidecar definitions (matches docker-compose.yml) ─────────────

export const DEFAULT_SIDECAR_DEFINITIONS: SidecarDefinition[] = [
  {
    name: "linkedin",
    image: "ghcr.io/community/mcp-linkedin:latest",
    containerName: "openzigs-mcp-linkedin",
    ports: { host: 5101, container: 5000 },
    env: {},
    network: "openzigs-network",
    requiredEnvVars: ["LINKEDIN_ACCESS_TOKEN"],
  },
  {
    name: "twitter",
    image: "ghcr.io/community/mcp-twitter:latest",
    containerName: "openzigs-mcp-twitter",
    ports: { host: 5102, container: 5000 },
    env: {},
    network: "openzigs-network",
    requiredEnvVars: ["TWITTER_BEARER_TOKEN"],
  },
  {
    name: "facebook",
    image: "ghcr.io/community/facebook-mcp-server:latest",
    containerName: "openzigs-mcp-facebook",
    ports: { host: 5103, container: 5000 },
    env: {},
    network: "openzigs-network",
    requiredEnvVars: ["FACEBOOK_PAGE_TOKEN"],
  },
  {
    name: "pinterest",
    image: "ghcr.io/collactivelabs/pinterest-mcp-server:latest",
    containerName: "openzigs-mcp-pinterest",
    ports: { host: 5104, container: 3052 },
    env: {},
    network: "openzigs-network",
    requiredEnvVars: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    volumes: ["pinterest-tokens:/app/tokens"],
  },
  {
    name: "word",
    image: "ghcr.io/community/office-word-mcp-server:latest",
    containerName: "openzigs-mcp-word",
    ports: { host: 5201, container: 5000 },
    env: {},
    network: "openzigs-network",
    requiredEnvVars: [],
  },
];

// ── Manager ──────────────────────────────────────────────────────────────────

export type DockerSidecarManagerOptions = {
  /** Override Docker socket path (default: /var/run/docker.sock) */
  socketPath?: string;
  /** Sidecar definitions to manage (default: DEFAULT_SIDECAR_DEFINITIONS) */
  definitions?: SidecarDefinition[];
  /** Health-check retry count before declaring unhealthy (default: 3) */
  healthRetries?: number;
  /** Delay between health-check retries in ms (default: 2000) */
  healthRetryDelay?: number;
  /** If true, skip sidecars whose required env vars are empty (default: true) */
  skipUnconfigured?: boolean;
  /** Overrides for the Docker constructor (for testing / remote hosts) */
  dockerInstance?: Docker;
};

export class DockerSidecarManager extends EventEmitter {
  private docker: Docker;
  private definitions: SidecarDefinition[];
  private healthRetries: number;
  private healthRetryDelay: number;
  private skipUnconfigured: boolean;
  private statuses: Map<string, SidecarStatus> = new Map();

  constructor(options: DockerSidecarManagerOptions = {}) {
    super();
    const socketPath = options.socketPath ?? resolveDockerSocketPath();
    this.docker = options.dockerInstance ?? new Docker({ socketPath });
    logger.debug(`DockerSidecarManager using socket: ${socketPath}`);
    this.definitions = options.definitions ?? DEFAULT_SIDECAR_DEFINITIONS;
    this.healthRetries = options.healthRetries ?? 3;
    this.healthRetryDelay = options.healthRetryDelay ?? 2000;
    this.skipUnconfigured = options.skipUnconfigured ?? true;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Provision and start all eligible sidecars.
   * Returns a map of sidecar name → sidecar URL for those that are
   * running and healthy.
   */
  async startAll(): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    await this.ensureNetwork();

    for (const def of this.definitions) {
      if (this.skipUnconfigured && !this.hasRequiredCredentials(def)) {
        logger.info(
          `Skipping sidecar "${def.name}": missing required env vars (${(def.requiredEnvVars ?? []).join(", ")})`
        );
        this.setStatus(def, { running: false, healthy: false, error: "credentials_missing" });
        continue;
      }

      try {
        await this.ensureSidecar(def);
        const url = `http://localhost:${def.ports.host}`;
        const healthy = await this.waitForHealthy(def, url);
        this.setStatus(def, {
          running: true,
          healthy,
          url,
          containerId: await this.getContainerId(def),
        });
        if (healthy) {
          results.set(def.name, url);
          this.emit("sidecar:healthy", this.statuses.get(def.name)!);
        } else {
          this.emit("sidecar:unhealthy", this.statuses.get(def.name)!);
        }
        this.emit("sidecar:started", this.statuses.get(def.name)!);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Failed to start sidecar "${def.name}": ${err.message}`);
        this.setStatus(def, { running: false, healthy: false, error: err.message });
        this.emit("sidecar:error", def.name, err);
      }
    }

    return results;
  }

  /** Stop and remove all managed sidecar containers. */
  async stopAll(): Promise<void> {
    for (const def of this.definitions) {
      try {
        await this.stopSidecar(def);
        this.setStatus(def, { running: false, healthy: false });
        this.emit("sidecar:stopped", this.statuses.get(def.name)!);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Failed to stop sidecar "${def.name}": ${err.message}`);
      }
    }
  }

  /** Restart a single sidecar by name. */
  async restartSidecar(name: string): Promise<SidecarStatus | null> {
    const def = this.definitions.find((d) => d.name === name);
    if (!def) return null;

    try {
      await this.stopSidecar(def);
      await this.ensureSidecar(def);
      const url = `http://localhost:${def.ports.host}`;
      const healthy = await this.waitForHealthy(def, url);
      this.setStatus(def, {
        running: true,
        healthy,
        url,
        containerId: await this.getContainerId(def),
      });
      return this.statuses.get(name) ?? null;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus(def, { running: false, healthy: false, error: err.message });
      return this.statuses.get(name) ?? null;
    }
  }

  /** Get current status of all sidecars. */
  getAllStatuses(): SidecarStatus[] {
    return Array.from(this.statuses.values());
  }

  /** Get status of a single sidecar by name. */
  getStatus(name: string): SidecarStatus | undefined {
    return this.statuses.get(name);
  }

  /** Check if Docker daemon is reachable. */
  async isDockerAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Return the list of sidecar names that have valid credentials configured. */
  getConfiguredSidecars(): string[] {
    return this.definitions
      .filter((def) => this.hasRequiredCredentials(def))
      .map((def) => def.name);
  }

  /** Return all sidecar definitions. */
  getDefinitions(): SidecarDefinition[] {
    return [...this.definitions];
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private hasRequiredCredentials(def: SidecarDefinition): boolean {
    if (!def.requiredEnvVars || def.requiredEnvVars.length === 0) return true;
    return def.requiredEnvVars.every((envVar) => {
      const value = process.env[envVar];
      return value !== undefined && value !== "";
    });
  }

  private async ensureNetwork(): Promise<void> {
    const networkName = "openzigs-network";
    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [networkName] },
      });
      if (networks.length === 0) {
        await this.docker.createNetwork({
          Name: networkName,
          Driver: "bridge",
        });
        logger.info(`Created Docker network: ${networkName}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not ensure Docker network "${networkName}": ${msg}`);
    }
  }

  private async ensureSidecar(def: SidecarDefinition): Promise<void> {
    // Check if container already exists
    const existing = await this.findContainer(def.containerName);

    if (existing) {
      const info = await existing.inspect();
      if (info.State.Running) {
        logger.debug(`Sidecar "${def.name}" already running (${existing.id.slice(0, 12)})`);
        return;
      }
      // Exists but stopped — start it
      logger.info(`Starting existing sidecar "${def.name}" (${existing.id.slice(0, 12)})`);
      await existing.start();
      return;
    }

    // Pull image if not available locally
    await this.pullImageIfNeeded(def.image);

    // Build envvar array
    const envArray = this.buildEnvArray(def);

    // Build port bindings
    const containerPort = `${def.ports.container}/tcp`;
    const portBindings: Record<string, Array<{ HostPort: string }>> = {
      [containerPort]: [{ HostPort: String(def.ports.host) }],
    };

    // Build volume binds
    const binds: string[] = [];
    if (def.volumes) {
      for (const vol of def.volumes) {
        binds.push(vol);
      }
    }

    const container = await this.docker.createContainer({
      Image: def.image,
      name: def.containerName,
      Env: envArray,
      ExposedPorts: { [containerPort]: {} },
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds.length > 0 ? binds : undefined,
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: def.network,
      },
    });

    logger.info(`Created sidecar "${def.name}" container (${container.id.slice(0, 12)})`);
    await container.start();
    logger.info(`Started sidecar "${def.name}"`);
  }

  private buildEnvArray(def: SidecarDefinition): string[] {
    const envArray: string[] = [];

    // Inject env from definition
    for (const [key, value] of Object.entries(def.env)) {
      envArray.push(`${key}=${value}`);
    }

    // Forward required env vars from host
    if (def.requiredEnvVars) {
      for (const envVar of def.requiredEnvVars) {
        const value = process.env[envVar];
        if (value) {
          envArray.push(`${envVar}=${value}`);
        }
      }
    }

    // Forward additional platform-specific env vars from host
    const platformEnvMap: Record<string, string[]> = {
      linkedin: ["LINKEDIN_ACCESS_TOKEN"],
      twitter: ["TWITTER_BEARER_TOKEN", "TWITTER_API_KEY", "TWITTER_API_SECRET"],
      facebook: ["FACEBOOK_PAGE_TOKEN"],
      pinterest: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    };

    const extraVars = platformEnvMap[def.name] ?? [];
    for (const envVar of extraVars) {
      const value = process.env[envVar];
      if (value && !envArray.some((e) => e.startsWith(`${envVar}=`))) {
        envArray.push(`${envVar}=${value}`);
      }
    }

    return envArray;
  }

  private async stopSidecar(def: SidecarDefinition): Promise<void> {
    const container = await this.findContainer(def.containerName);
    if (!container) return;

    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop({ t: 10 });
      }
      await container.remove({ force: true });
      logger.info(`Stopped and removed sidecar "${def.name}"`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Error stopping sidecar "${def.name}": ${msg}`);
    }
  }

  private async findContainer(
    containerName: string
  ): Promise<Docker.Container | null> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { name: [containerName] },
      });

      // Docker name filter is prefix-based, so exact-match
      const match = containers.find((c) =>
        c.Names.some((n) => n === `/${containerName}`)
      );
      if (!match) return null;
      return this.docker.getContainer(match.Id);
    } catch {
      return null;
    }
  }

  private async getContainerId(def: SidecarDefinition): Promise<string | undefined> {
    const container = await this.findContainer(def.containerName);
    if (!container) return undefined;
    const info = await container.inspect();
    return info.Id;
  }

  private async pullImageIfNeeded(imageName: string): Promise<void> {
    try {
      await this.docker.getImage(imageName).inspect();
      logger.debug(`Image "${imageName}" already available locally`);
    } catch {
      logger.info(`Pulling image "${imageName}"...`);
      const stream = await this.docker.pull(imageName);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : resolve())
        );
      });
      logger.info(`Pulled image "${imageName}"`);
    }
  }

  private async waitForHealthy(
    def: SidecarDefinition,
    baseUrl: string
  ): Promise<boolean> {
    const healthPath = def.healthCheckPath ?? "/health";
    const timeout = def.healthCheckTimeout ?? 5000;
    const url = `${baseUrl}${healthPath}`;

    for (let attempt = 0; attempt < this.healthRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (response.ok) {
          logger.info(`Sidecar "${def.name}" healthy after ${attempt + 1} attempt(s)`);
          return true;
        }
      } catch {
        // Expected while container is booting
      }

      if (attempt < this.healthRetries - 1) {
        await this.delay(this.healthRetryDelay);
      }
    }

    // Final attempt: check the MCP endpoint instead (some sidecars don't have /health)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "ping", params: {} }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok || response.status < 500) {
        logger.info(`Sidecar "${def.name}" reachable via /mcp endpoint`);
        return true;
      }
    } catch {
      // Not reachable
    }

    logger.warn(
      `Sidecar "${def.name}" failed health check after ${this.healthRetries} attempts`
    );
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private setStatus(
    def: SidecarDefinition,
    partial: Partial<SidecarStatus>
  ): void {
    const existing = this.statuses.get(def.name);
    this.statuses.set(def.name, {
      name: def.name,
      containerName: def.containerName,
      running: partial.running ?? existing?.running ?? false,
      healthy: partial.healthy ?? existing?.healthy ?? false,
      containerId: partial.containerId ?? existing?.containerId,
      url: partial.url ?? existing?.url ?? `http://localhost:${def.ports.host}`,
      error: partial.error,
    });
  }

  // ── Typed events ────────────────────────────────────────────────────────

  override on<K extends keyof SidecarManagerEvents>(
    event: K,
    listener: SidecarManagerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof SidecarManagerEvents>(
    event: K,
    ...args: Parameters<SidecarManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
