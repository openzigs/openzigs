import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DockerSidecarManager, DEFAULT_SIDECAR_DEFINITIONS, resolveDockerSocketPath } from "./docker-sidecar-manager.js";
import type { SidecarDefinition } from "./docker-sidecar-manager.js";

// ── Mock Docker ──────────────────────────────────────────────────────────────

const createMockContainer = (running = false) => ({
  id: "abc123def456",
  inspect: vi.fn().mockResolvedValue({
    Id: "abc123def456",
    State: { Running: running },
    Config: { Image: "test:latest" },
  }),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
});

const createMockDocker = () => {
  const mockContainer = createMockContainer(false);

  return {
    ping: vi.fn().mockResolvedValue("OK"),
    listContainers: vi.fn().mockResolvedValue([]),
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    listNetworks: vi.fn().mockResolvedValue([]),
    createNetwork: vi.fn().mockResolvedValue({ id: "net-123" }),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
    }),
    pull: vi.fn().mockResolvedValue({ on: vi.fn() }),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
    },
    _mockContainer: mockContainer,
  };
};

const createTestDefinition = (overrides: Partial<SidecarDefinition> = {}): SidecarDefinition => ({
  name: "test-sidecar",
  image: "test/sidecar:latest",
  containerName: "openzigs-test-sidecar",
  ports: { host: 9999, container: 5000 },
  env: {},
  network: "openzigs-network",
  requiredEnvVars: ["TEST_TOKEN"],
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DockerSidecarManager", () => {
  let mockDocker: ReturnType<typeof createMockDocker>;

  beforeEach(() => {
    mockDocker = createMockDocker();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("constructor", () => {
    it("uses default definitions when none are provided", () => {
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
      });
      expect(manager.getDefinitions()).toEqual(DEFAULT_SIDECAR_DEFINITIONS);
    });

    it("accepts custom definitions", () => {
      const custom = [createTestDefinition()];
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: custom,
      });
      expect(manager.getDefinitions()).toEqual(custom);
    });
  });

  describe("isDockerAvailable", () => {
    it("returns true when Docker daemon responds", async () => {
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
      });
      const available = await manager.isDockerAvailable();
      expect(available).toBe(true);
      expect(mockDocker.ping).toHaveBeenCalled();
    });

    it("returns false when Docker daemon is unreachable", async () => {
      mockDocker.ping.mockRejectedValue(new Error("ENOENT"));
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
      });
      const available = await manager.isDockerAvailable();
      expect(available).toBe(false);
    });
  });

  describe("getConfiguredSidecars", () => {
    it("returns sidecars with all required env vars set", () => {
      vi.stubEnv("TEST_TOKEN", "some-token");
      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
      });
      expect(manager.getConfiguredSidecars()).toEqual(["test-sidecar"]);
    });

    it("excludes sidecars with missing env vars", () => {
      delete process.env.TEST_TOKEN;
      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
      });
      expect(manager.getConfiguredSidecars()).toEqual([]);
    });

    it("includes sidecars with no required env vars", () => {
      const def = createTestDefinition({ requiredEnvVars: [] });
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
      });
      expect(manager.getConfiguredSidecars()).toEqual(["test-sidecar"]);
    });
  });

  describe("startAll", () => {
    it("skips unconfigured sidecars when skipUnconfigured is true", async () => {
      delete process.env.TEST_TOKEN;
      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        skipUnconfigured: true,
      });

      const urls = await manager.startAll();
      expect(urls.size).toBe(0);
      expect(mockDocker.createContainer).not.toHaveBeenCalled();

      const status = manager.getStatus("test-sidecar");
      expect(status?.running).toBe(false);
      expect(status?.error).toBe("credentials_missing");
    });

    it("starts container when credentials are configured", async () => {
      vi.stubEnv("TEST_TOKEN", "my-secret-token");

      // Mock health check succeeds
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const urls = await manager.startAll();
      expect(urls.size).toBe(1);
      expect(urls.get("test-sidecar")).toBe("http://localhost:9999");
      expect(mockDocker.createContainer).toHaveBeenCalled();
    });

    it("reuses existing running container", async () => {
      vi.stubEnv("TEST_TOKEN", "token");

      const runningContainer = createMockContainer(true);
      mockDocker.listContainers.mockResolvedValue([
        { Id: "existing-123", Names: ["/openzigs-test-sidecar"] },
      ]);
      mockDocker.getContainer.mockReturnValue(runningContainer);

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const urls = await manager.startAll();
      expect(urls.size).toBe(1);
      expect(mockDocker.createContainer).not.toHaveBeenCalled();
      expect(runningContainer.start).not.toHaveBeenCalled();
    });

    it("starts existing stopped container", async () => {
      vi.stubEnv("TEST_TOKEN", "token");

      const stoppedContainer = createMockContainer(false);
      mockDocker.listContainers.mockResolvedValue([
        { Id: "existing-123", Names: ["/openzigs-test-sidecar"] },
      ]);
      mockDocker.getContainer.mockReturnValue(stoppedContainer);

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const urls = await manager.startAll();
      expect(urls.size).toBe(1);
      expect(stoppedContainer.start).toHaveBeenCalled();
      expect(mockDocker.createContainer).not.toHaveBeenCalled();
    });

    it("creates network if it does not exist", async () => {
      vi.stubEnv("TEST_TOKEN", "token");
      mockDocker.listNetworks.mockResolvedValue([]);

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      await manager.startAll();
      expect(mockDocker.createNetwork).toHaveBeenCalledWith({
        Name: "openzigs-network",
        Driver: "bridge",
      });
    });

    it("does not create network if it already exists", async () => {
      vi.stubEnv("TEST_TOKEN", "token");
      mockDocker.listNetworks.mockResolvedValue([{ Name: "openzigs-network" }]);

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      await manager.startAll();
      expect(mockDocker.createNetwork).not.toHaveBeenCalled();
    });

    it("emits sidecar:started event", async () => {
      vi.stubEnv("TEST_TOKEN", "token");
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const events: string[] = [];
      manager.on("sidecar:started", () => events.push("started"));
      manager.on("sidecar:healthy", () => events.push("healthy"));

      await manager.startAll();
      expect(events).toContain("started");
      expect(events).toContain("healthy");
    });

    it("emits sidecar:unhealthy when health check fails", async () => {
      vi.stubEnv("TEST_TOKEN", "token");
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const events: string[] = [];
      manager.on("sidecar:unhealthy", () => events.push("unhealthy"));

      await manager.startAll();
      expect(events).toContain("unhealthy");
    });

    it("emits sidecar:error on Docker failure", async () => {
      vi.stubEnv("TEST_TOKEN", "token");
      mockDocker.createContainer.mockRejectedValue(new Error("image not found"));
      mockDocker.getImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error("not found")),
      });
      mockDocker.pull.mockRejectedValue(new Error("pull failed"));

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const errors: string[] = [];
      manager.on("sidecar:error", (name) => errors.push(name));

      await manager.startAll();
      expect(errors).toContain("test-sidecar");
    });

    it("pulls image when not available locally", async () => {
      vi.stubEnv("TEST_TOKEN", "token");
      mockDocker.getImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error("not found")),
      });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      await manager.startAll();
      expect(mockDocker.pull).toHaveBeenCalledWith("test/sidecar:latest");
    });
  });

  describe("stopAll", () => {
    it("stops and removes running containers", async () => {
      const container = createMockContainer(true);
      mockDocker.listContainers.mockResolvedValue([
        { Id: "abc123", Names: ["/openzigs-test-sidecar"] },
      ]);
      mockDocker.getContainer.mockReturnValue(container);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
      });

      await manager.stopAll();
      expect(container.stop).toHaveBeenCalledWith({ t: 10 });
      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });

    it("emits sidecar:stopped event", async () => {
      mockDocker.listContainers.mockResolvedValue([]);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
      });

      const events: string[] = [];
      manager.on("sidecar:stopped", () => events.push("stopped"));

      await manager.stopAll();
      expect(events).toContain("stopped");
    });
  });

  describe("restartSidecar", () => {
    it("returns null for unknown sidecar name", async () => {
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [createTestDefinition()],
      });

      const result = await manager.restartSidecar("nonexistent");
      expect(result).toBeNull();
    });

    it("stops, removes, and recreates the sidecar", async () => {
      vi.stubEnv("TEST_TOKEN", "token");

      const container = createMockContainer(true);
      mockDocker.listContainers
        // First call: stopSidecar finds container
        .mockResolvedValueOnce([{ Id: "old-123", Names: ["/openzigs-test-sidecar"] }])
        // Second call: ensureSidecar findContainer (after removal)
        .mockResolvedValueOnce([])
        // Third call: getContainerId
        .mockResolvedValueOnce([{ Id: "new-456", Names: ["/openzigs-test-sidecar"] }]);
      mockDocker.getContainer.mockReturnValue(container);

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        healthRetries: 1,
        healthRetryDelay: 10,
      });

      const status = await manager.restartSidecar("test-sidecar");
      expect(status).toBeTruthy();
      expect(status?.running).toBe(true);
    });
  });

  describe("getAllStatuses", () => {
    it("returns empty array before any operations", () => {
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [],
      });
      expect(manager.getAllStatuses()).toEqual([]);
    });

    it("returns status for all sidecars after startAll", async () => {
      delete process.env.TEST_TOKEN;
      const def = createTestDefinition();
      const manager = new DockerSidecarManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dockerInstance: mockDocker as any,
        definitions: [def],
        skipUnconfigured: true,
      });

      await manager.startAll();
      const statuses = manager.getAllStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0]!.name).toBe("test-sidecar");
      expect(statuses[0]!.running).toBe(false);
    });
  });

  describe("DEFAULT_SIDECAR_DEFINITIONS", () => {
    it("is empty (all sidecars migrated to native MCP servers)", () => {
      expect(DEFAULT_SIDECAR_DEFINITIONS).toHaveLength(0);
    });
  });
});

describe("resolveDockerSocketPath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a string path", () => {
    const socketPath = resolveDockerSocketPath();
    expect(typeof socketPath).toBe("string");
    expect(socketPath.length).toBeGreaterThan(0);
  });

  it("returns a Unix socket path on non-Windows platforms", () => {
    // On the macOS/Linux test runner, it should resolve to a Unix socket
    if (process.platform !== "win32") {
      const socketPath = resolveDockerSocketPath();
      expect(socketPath).toMatch(/docker/);
      expect(socketPath).not.toBe("//./pipe/docker_engine");
    }
  });

  it("returns Windows named pipe when process.platform is win32", () => {
    // Mock process.platform to "win32" using Object.defineProperty
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const socketPath = resolveDockerSocketPath();
      expect(socketPath).toBe("//./pipe/docker_engine");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("does not return Windows named pipe on darwin", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const socketPath = resolveDockerSocketPath();
      expect(socketPath).not.toBe("//./pipe/docker_engine");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("does not return Windows named pipe on linux", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const socketPath = resolveDockerSocketPath();
      expect(socketPath).not.toBe("//./pipe/docker_engine");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
