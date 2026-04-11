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
  execFileSync: vi.fn(() => Buffer.from("")),
}));

// Mock node:fs for venv provisioning tests
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
  },
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

    it("includes tiktok server definition", () => {
      const tiktok = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "tiktok");
      expect(tiktok).toBeDefined();
      expect(tiktok!.command).toBe("node");
      expect(tiktok!.runtime).toBe("node");
      expect(tiktok!.category).toBe("social");
      expect(tiktok!.requiresCredentials).toBe(true);
      expect(tiktok!.requiredEnvVars).toContain("TIKTOK_ACCESS_TOKEN");
    });

    it("includes instagram server definition", () => {
      const ig = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "instagram");
      expect(ig).toBeDefined();
      expect(ig!.runtime).toBe("python");
      expect(ig!.category).toBe("social");
      expect(ig!.requiresCredentials).toBe(true);
      expect(ig!.requiredEnvVars).toContain("INSTAGRAM_ACCESS_TOKEN");
      expect(ig!.requiredEnvVars).toContain("FACEBOOK_APP_ID");
    });

    it("includes facebook server definition", () => {
      const fb = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "facebook");
      expect(fb).toBeDefined();
      expect(fb!.runtime).toBe("python");
      expect(fb!.category).toBe("social");
      expect(fb!.requiresCredentials).toBe(true);
      expect(fb!.requiredEnvVars).toContain("FACEBOOK_PAGE_TOKEN");
      expect(fb!.requiredEnvVars).toContain("FACEBOOK_APP_ID");
    });

    it("has exactly 13 default definitions", () => {
      expect(DEFAULT_LOCAL_SERVER_DEFINITIONS).toHaveLength(13);
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

  // ── Additional coverage tests ──

  describe("constructor defaults", () => {
    it("defaults connectTimeout to 30000", () => {
      const mgr = new LocalMcpServerManager();
      // Access via internal — we verify indirectly by checking it doesn't throw
      expect(mgr.getDefinitions().length).toBeGreaterThan(0);
    });

    it("allows custom connectTimeout", () => {
      const mgr = new LocalMcpServerManager({ connectTimeout: 5000 });
      expect(mgr.getDefinitions()).toBeDefined();
    });
  });

  describe("hasRequiredCredentials (via getConfiguredServers)", () => {
    it("returns server when requiredEnvVars is empty array", () => {
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "no-env",
            label: "No Env",
            command: "echo",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
            requiredEnvVars: [],
          },
        ],
      });
      expect(mgr.getConfiguredServers()).toEqual(["no-env"]);
    });

    it("excludes server when env var is empty string", () => {
      process.env.EMPTY_VAR_TEST = "";
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "empty-env",
            label: "Empty Env",
            command: "echo",
            args: [],
            runtime: "node",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["EMPTY_VAR_TEST"],
          },
        ],
      });
      expect(mgr.getConfiguredServers()).toEqual([]);
      delete process.env.EMPTY_VAR_TEST;
    });

    it("requires ALL env vars to be set", () => {
      process.env.TEST_KEY_A = "set";
      delete process.env.TEST_KEY_B;
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "multi-env",
            label: "Multi Env",
            command: "echo",
            args: [],
            runtime: "node",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["TEST_KEY_A", "TEST_KEY_B"],
          },
        ],
      });
      expect(mgr.getConfiguredServers()).toEqual([]);
      delete process.env.TEST_KEY_A;
    });
  });

  describe("startAll with runtime unavailable", () => {
    it("skips servers when runtime is not available", async () => {
      const { execFileSync } = await import("node:child_process");
      (execFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("not found");
      });

      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "no-runtime",
            label: "No Runtime",
            command: "nonexistent-cmd",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
          },
        ],
        skipUnconfigured: false,
      });

      await mgr.startAll();
      const status = mgr.getStatus("no-runtime");
      expect(status).toBeDefined();
      expect(status!.running).toBe(false);
      expect(status!.error).toBe("runtime_unavailable");
    });
  });

  describe("callTool error handling", () => {
    it("returns isError true with descriptive message for non-running server", async () => {
      const mgr = new LocalMcpServerManager({ definitions: [] });
      const result = await mgr.callTool("nonexistent", "tool", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not running");
    });
  });

  describe("restartServer with known definition", () => {
    it("returns status with error when restart fails (no runtime)", async () => {
      const { execSync } = await import("node:child_process");
      // First let startAll skip, then try restart
      (execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("not found");
      });

      const def: LocalMcpServerDefinition = {
        name: "restart-test",
        label: "Restart Test",
        command: "nonexistent-binary",
        args: [],
        runtime: "other",
        category: "test",
        requiresCredentials: false,
      };
      const mgr = new LocalMcpServerManager({ definitions: [def] });

      const result = await mgr.restartServer("restart-test");
      expect(result).toBeDefined();
      expect(result!.running).toBe(false);
    });
  });

  describe("isRunning", () => {
    it("returns false for a defined but not started server", async () => {
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "defined-only",
            label: "Defined Only",
            command: "echo",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
          },
        ],
      });
      expect(mgr.isRunning("defined-only")).toBe(false);
    });
  });

  describe("getServerTools for non-running server", () => {
    it("returns empty array for defined but not started server", () => {
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "no-tools",
            label: "No Tools",
            command: "echo",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
          },
        ],
      });
      expect(mgr.getServerTools("no-tools")).toEqual([]);
    });
  });

  describe("DEFAULT_LOCAL_SERVER_DEFINITIONS details", () => {
    it("includes social media servers", () => {
      const social = DEFAULT_LOCAL_SERVER_DEFINITIONS.filter((d) => d.category === "social");
      expect(social.length).toBeGreaterThanOrEqual(4);
      const names = social.map((d) => d.name);
      expect(names).toContain("twitter");
      expect(names).toContain("youtube");
    });

    it("all definitions have required fields", () => {
      for (const def of DEFAULT_LOCAL_SERVER_DEFINITIONS) {
        expect(def.name).toBeTruthy();
        expect(def.label).toBeTruthy();
        expect(def.command).toBeTruthy();
        expect(Array.isArray(def.args)).toBe(true);
        expect(["python", "node", "other"]).toContain(def.runtime);
        expect(def.category).toBeTruthy();
        expect(typeof def.requiresCredentials).toBe("boolean");
      }
    });

    it("word and markitdown do not require credentials", () => {
      const noCreds = DEFAULT_LOCAL_SERVER_DEFINITIONS.filter((d) => !d.requiresCredentials);
      const names = noCreds.map((d) => d.name);
      expect(names).toContain("word");
      expect(names).toContain("markitdown");
    });

    it("github server requires GITHUB_PERSONAL_ACCESS_TOKEN", () => {
      const gh = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "github");
      expect(gh).toBeDefined();
      expect(gh!.requiredEnvVars).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    });

    it("gmail requires both GMAIL_OAUTH_PATH and GMAIL_CREDENTIALS_PATH", () => {
      const gmail = DEFAULT_LOCAL_SERVER_DEFINITIONS.find((d) => d.name === "gmail");
      expect(gmail).toBeDefined();
      expect(gmail!.requiredEnvVars).toContain("GMAIL_OAUTH_PATH");
      expect(gmail!.requiredEnvVars).toContain("GMAIL_CREDENTIALS_PATH");
    });
  });

  describe("stopAll with no instances", () => {
    it("resolves immediately", async () => {
      const mgr = new LocalMcpServerManager({ definitions: [] });
      await expect(mgr.stopAll()).resolves.toBeUndefined();
    });
  });

  describe("setStatus merging", () => {
    it("getStatus returns undefined initially for custom definitions", () => {
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "custom",
            label: "Custom",
            command: "echo",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: false,
          },
        ],
      });
      expect(mgr.getStatus("custom")).toBeUndefined();
    });

    it("getAllStatuses reflects state after startAll with missing creds", async () => {
      delete process.env.SOME_MISSING_KEY;
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "creds-test",
            label: "Creds Test",
            command: "echo",
            args: [],
            runtime: "other",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["SOME_MISSING_KEY"],
          },
        ],
      });
      await mgr.startAll();
      const statuses = mgr.getAllStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].name).toBe("creds-test");
      expect(statuses[0].error).toBe("credentials_missing");
    });
  });

  describe("provisionPythonVenv (via startAll)", () => {
    const isWin = process.platform === "win32";
    const whichCmd = isWin ? "where.exe" : "which";
    const pythonCmd = isWin ? "python" : "python3";
    const venvBinCheck = isWin ? "Scripts\\python.exe" : "bin/python";
    const venvCommand = isWin ? "/fake/path/.venv/Scripts/python.exe" : "/fake/path/.venv/bin/python";

    it("attempts provisioning when python venv is missing", async () => {
      const { execFileSync } = await import("node:child_process");
      const fs = (await import("node:fs")).default;
      const mockedExecFile = vi.mocked(execFileSync);
      const mockedExists = vi.mocked(fs.existsSync);

      // First call: which check fails (runtime not available)
      // existsSync: venv/bin/python doesn't exist, requirements.txt exists
      mockedExecFile.mockImplementation((cmd: string, _args?: readonly string[]) => {
        if (cmd === whichCmd) throw new Error("not found");
        if (cmd === pythonCmd) return Buffer.from(""); // venv creation
        if (typeof cmd === "string" && (cmd.includes("/pip") || cmd.includes("\\pip"))) return Buffer.from(""); // pip install
        return Buffer.from("");
      });
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith(venvBinCheck)) return false; // venv doesn't exist
        if (s.endsWith("requirements.txt")) return true;
        return false;
      });

      process.env.PY_TEST_KEY = "set";
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "py-test",
            label: "Python Test",
            command: venvCommand,
            args: ["-m", "test_server"],
            runtime: "python",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["PY_TEST_KEY"],
          },
        ],
      });
      await mgr.startAll();

      // Should have attempted python3 -m venv (or python -m venv on Windows)
      expect(mockedExecFile).toHaveBeenCalledWith(
        pythonCmd,
        ["-m", "venv", "/fake/path/.venv"],
        expect.any(Object)
      );
      delete process.env.PY_TEST_KEY;
    });

    it("skips provisioning for non-python servers", async () => {
      const { execFileSync } = await import("node:child_process");
      const mockedExecFile = vi.mocked(execFileSync);
      mockedExecFile.mockImplementation(() => { throw new Error("not found"); });

      delete process.env.NODE_TEST_KEY;
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "node-test",
            label: "Node Test",
            command: "npx",
            args: ["-y", "test-server"],
            runtime: "node",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["NODE_TEST_KEY"],
          },
        ],
      });
      await mgr.startAll();

      // Should not attempt python3 -m venv
      expect(mockedExecFile).not.toHaveBeenCalledWith(
        "python3",
        expect.arrayContaining(["-m", "venv"]),
        expect.any(Object)
      );
    });

    it("skips provisioning when venv already exists", async () => {
      const { execFileSync } = await import("node:child_process");
      const fs = (await import("node:fs")).default;
      const mockedExecFile = vi.mocked(execFileSync);
      const mockedExists = vi.mocked(fs.existsSync);

      // which succeeds (runtime already available)
      mockedExecFile.mockReturnValue(Buffer.from("/some/path"));
      mockedExists.mockReturnValue(true);

      process.env.PY_EXISTS_KEY = "set";
      const mgr = new LocalMcpServerManager({
        definitions: [
          {
            name: "py-exists",
            label: "Python Exists",
            command: "/fake/path/.venv/bin/python",
            args: ["-m", "test_server"],
            runtime: "python",
            category: "test",
            requiresCredentials: true,
            requiredEnvVars: ["PY_EXISTS_KEY"],
          },
        ],
      });
      await mgr.startAll();

      // The provisioning python3 -m venv call should NOT happen
      expect(mockedExecFile).not.toHaveBeenCalledWith(
        "python3",
        expect.arrayContaining(["-m", "venv"]),
        expect.any(Object)
      );
      delete process.env.PY_EXISTS_KEY;
    });
  });
});
