import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock node:fs/promises to control file reads
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockChmod = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    chmod: (...args: unknown[]) => mockChmod(...args),
  },
}));

// Minimal valid default config for tests
const validDefaultConfig = {
  server: { port: 3000 },
  logging: { level: "info" },
  auth: {
    mode: "local",
    token: "a".repeat(64),
    rateLimit: { windowMs: 60000, max: 100 },
  },
};

describe("config/index", () => {
  let mod: typeof import("./index.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mod = await import("./index.js");
  });

  describe("loadConfig", () => {
    it("loads config when default.json exists and user config does not", async () => {
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(validDefaultConfig));
        }
        // User config not found
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.server.port).toBe(3000);
      expect(config.auth.mode).toBe("local");
    });

    it("merges user config over default config", async () => {
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(validDefaultConfig));
        }
        return Promise.resolve(JSON.stringify({
          server: { port: 4000 },
          logging: { level: "debug" },
        }));
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.server.port).toBe(4000);
      expect(config.logging.level).toBe("debug");
      // Auth comes from default
      expect(config.auth.mode).toBe("local");
    });

    it("generates auth token when missing or too short", async () => {
      const configNoToken = {
        ...validDefaultConfig,
        auth: { ...validDefaultConfig.auth, token: "short" },
      };
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(configNoToken));
        }
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      // Should have generated a 64-char token
      expect(config.auth.token).toBeDefined();
      expect(config.auth.token!.length).toBe(64);
      // Should have written the file
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("throws on invalid config", async () => {
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify({ invalid: true }));
        }
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      await expect(mod.loadConfig({ configPath: "/tmp/test-config.json" })).rejects.toThrow("Invalid config");
    });

    it("interpolates environment variables", async () => {
      process.env.TEST_PORT_VALUE = "9999";
      const configWithEnv = {
        ...validDefaultConfig,
        server: { port: 3000 },
        logging: { level: "${TEST_PORT_VALUE}" },
      };
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(configWithEnv));
        }
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.logging.level).toBe("9999");
      delete process.env.TEST_PORT_VALUE;
    });

    it("does not generate token when auth mode is not local", async () => {
      const ghConfig = {
        ...validDefaultConfig,
        auth: { ...validDefaultConfig.auth, mode: "github", token: undefined },
      };
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(ghConfig));
        }
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.auth.mode).toBe("github");
      // Should NOT have written a file to generate a token
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("preserves long existing token", async () => {
      const longToken = "b".repeat(64);
      const configWithToken = {
        ...validDefaultConfig,
        auth: { ...validDefaultConfig.auth, token: longToken },
      };
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(configWithToken));
        }
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.auth.token).toBe(longToken);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("strips UTF-8 BOM from config files (Windows PowerShell compatibility)", async () => {
      // PowerShell 5.1's Set-Content/Out-File default encoding prepends EF BB BF.
      // Without BOM stripping, JSON.parse throws and the backend fails to start.
      const bom = "\uFEFF";
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(bom + JSON.stringify(validDefaultConfig));
        }
        return Promise.resolve(bom + JSON.stringify({
          copilot: { provider: { type: "ollama", baseUrl: "http://localhost:11434" } },
        }));
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.copilot?.provider).toEqual({
        type: "ollama",
        baseUrl: "http://localhost:11434",
      });
    });

    it("handles optional sections (sentinel, knowledge, voice)", async () => {
      const configWithOptional = {
        ...validDefaultConfig,
        sentinel: { enabled: true, model: "gpt-4o" },
        knowledge: { enabled: true, chunkSize: 500 },
        voice: { enabled: true, provider: "google" },
      };
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("default.json")) {
          return Promise.resolve(JSON.stringify(configWithOptional));
        }
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      });

      const config = await mod.loadConfig({ configPath: "/tmp/test-config.json" });
      expect(config.sentinel?.enabled).toBe(true);
      expect(config.knowledge?.chunkSize).toBe(500);
      expect(config.voice?.provider).toBe("google");
    });
  });

  describe("Zod schemas", () => {
    it("exports mcpServerConfigSchema", () => {
      expect(mod.mcpServerConfigSchema).toBeDefined();

      const localResult = mod.mcpServerConfigSchema.safeParse({
        type: "local",
        command: "node",
        args: ["server.js"],
      });
      expect(localResult.success).toBe(true);

      const httpResult = mod.mcpServerConfigSchema.safeParse({
        type: "http",
        url: "http://localhost:3000",
      });
      expect(httpResult.success).toBe(true);
    });

    it("exports customAgentSchema", () => {
      expect(mod.customAgentSchema).toBeDefined();
      const result = mod.customAgentSchema.safeParse({
        name: "test-agent",
        description: "A test agent",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid customAgent (extra fields via strict)", () => {
      const result = mod.customAgentSchema.safeParse({
        name: "test",
        unknownField: true,
      });
      expect(result.success).toBe(false);
    });
  });
});
