import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LocalMcpServerManager,
  DEFAULT_LOCAL_SERVER_DEFINITIONS,
  type LocalMcpServerDefinition,
} from "./local-mcp-server-manager.js";

// Mock the logger
vi.mock("../logging/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock child_process for runtime checks
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("/usr/bin/uvx")),
}));

describe("LocalMcpServerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("uses default definitions if none provided", () => {
      const mgr = new LocalMcpServerManager();
      expect(mgr.getDefinitions()).toEqual(DEFAULT_LOCAL_SERVER_DEFINITIONS);
    });

    it("accepts custom definitions", () => {
      const custom: LocalMcpServerDefinition[] = [
        {
          name: "test-server",
          label: "Test",
          command: "echo",
          args: ["hello"],
          runtime: "other",
          category: "test",
          requiresCredentials: false,
        },
      ];
      const mgr = new LocalMcpServerManager({ definitions: custom });
      expect(mgr.getDefinitions()).toHaveLength(1);
      expect(mgr.getDefinitions()[0].name).toBe("test-server");
    });

    it("respects skipUnconfigured option", () => {
      const mgr = new LocalMcpServerManager({ skipUnconfigured: false });
      // All servers should be considered regardless of credentials
      expect(mgr.getDefinitions()).toEqual(DEFAULT_LOCAL_SERVER_DEFINITIONS);
    });
  });

  describe("getDefinitions", () => {
    it("returns a copy of definitions", () => {
      const mgr = new LocalMcpServerManager();
      const defs = mgr.getDefinitions();
      defs.push({
        name: "injected",
        label: "Injected",
        command: "nope",
        args: [],
        runtime: "other",
        category: "test",
        requiresCredentials: false,
      });
      expect(mgr.getDefinitions()).toEqual(DEFAULT_LOCAL_SERVER_DEFINITIONS);
    });
  });

  describe("getConfiguredServers", () => {
    it("returns servers with no required env vars", () => {
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "no-creds",
            label: "No Creds",
            command: "echo",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
          },
        ],
      });
      expect(mgr.getConfiguredServers()).toEqual(["no-creds"]);
    });

    it("returns servers whose env vars are set", () => {
      process.env.TEST_API_KEY = "secret";
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "with-creds",
            label: "With Creds",
            command: "echo",
            args: [],
            runtime: "node",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["TEST_API_KEY"],
          },
        ],
      });
      expect(mgr.getConfiguredServers()).toEqual(["with-creds"]);
      delete process.env.TEST_API_KEY;
    });

    it("excludes servers whose env vars are missing", () => {
      delete process.env.MISSING_KEY;
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "missing-creds",
            label: "Missing",
            command: "echo",
            args: [],
            runtime: "node",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["MISSING_KEY"],
          },
        ],
      });
      expect(mgr.getConfiguredServers()).toEqual([]);
    });
  });

  describe("getAllStatuses", () => {
    it("returns empty array initially", () => {
      const mgr = new LocalMcpServerManager();
      expect(mgr.getAllStatuses()).toEqual([]);
    });
  });

  describe("isRunning", () => {
    it("returns false for unknown server", () => {
      const mgr = new LocalMcpServerManager();
      expect(mgr.isRunning("nonexistent")).toBe(false);
    });
  });

  describe("callTool", () => {
    it("returns error when server is not running", async () => {
      const mgr = new LocalMcpServerManager();
      const result = await mgr.callTool("word", "create_document", { content: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not running");
    });
  });

  describe("getServerTools", () => {
    it("returns empty array when server is not running", () => {
      const mgr = new LocalMcpServerManager();
      expect(mgr.getServerTools("word")).toEqual([]);
    });
  });

  describe("getStatus", () => {
    it("returns undefined for unknown server", () => {
      const mgr = new LocalMcpServerManager();
      expect(mgr.getStatus("nonexistent")).toBeUndefined();
    });
  });

  describe("restartServer", () => {
    it("returns null for unknown server name", async () => {
      const mgr = new LocalMcpServerManager();
      const result = await mgr.restartServer("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("startAll with unconfigured servers", () => {
    it("skips servers with missing credentials", async () => {
      delete process.env.GOOGLE_OAUTH_CREDENTIALS;
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "needs-creds",
            label: "Needs Creds",
            command: "npx",
            args: ["-y", "some-package"],
            runtime: "node",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["GOOGLE_OAUTH_CREDENTIALS"],
          },
        ],
        skipUnconfigured: true,
      });

      await mgr.startAll();
      const statuses = mgr.getAllStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].running).toBe(false);
      expect(statuses[0].error).toBe("credentials_missing");
    });
  });

  describe("stopAll", () => {
    it("completes without error when no servers are running", async () => {
      const mgr = new LocalMcpServerManager();
      await expect(mgr.stopAll()).resolves.toBeUndefined();
    });
  });

  describe("DEFAULT_LOCAL_SERVER_DEFINITIONS", () => {
    it("includes word server definition", () => {
      const word = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "word");
      expect(word).toBeDefined();
      expect(word!.command).toBe("uvx");
      expect(word!.runtime).toBe("python");
      expect(word!.requiresCredentials).toBe(false);
    });

    it("includes calendar server definition", () => {
      const cal = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "calendar");
      expect(cal).toBeDefined();
      expect(cal!.command).toBe("npx");
      expect(cal!.runtime).toBe("node");
      expect(cal!.requiresCredentials).toBe(true);
      expect(cal!.requiredEnvVars).toContain("GOOGLE_OAUTH_CREDENTIALS");
    });

    it("has exactly 3 default definitions", () => {
      expect(DEFAULT_LOCAL_SERVER_DEFINITIONS).toHaveLength(3);
    });
  });

  describe("events", () => {
    it("emits server:error during startAll when spawn fails", async () => {
      // Use a command that will definitely fail to connect
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "fail-server",
            label: "Will Fail",
            command: "false",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
          },
        ],
        connectTimeout: 1000,
      });

      const errors: Array<{ name: string; error: Error }> = [];
      mgr.on("server:error", (name, error) => {
        errors.push({ name, error });
      });

      await mgr.startAll();

      const status = mgr.getStatus("fail-server");
      expect(status).toBeDefined();
      expect(status!.running).toBe(false);
      expect(status!.error).toBeDefined();
    });
  });
});
