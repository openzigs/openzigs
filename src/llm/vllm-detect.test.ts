import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  autoRegisterIfDetected,
  detectLocalVllm,
} from "./vllm-detect.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vllm-detect-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("detectLocalVllm", () => {
  it("returns available=true with the first model id", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ id: "Qwen/Qwen2.5-14B-Instruct-AWQ" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const res = await detectLocalVllm("http://127.0.0.1:8000", 1000, {
      fetchImpl,
    });
    expect(res).toEqual({
      available: true,
      model: "Qwen/Qwen2.5-14B-Instruct-AWQ",
    });
  });

  it("returns available=false on HTTP error", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await detectLocalVllm("http://127.0.0.1:8000", 1000, {
      fetchImpl,
    });
    expect(res.available).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
  });

  it("returns available=false on network error / timeout", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await detectLocalVllm("http://127.0.0.1:8000", 100, {
      fetchImpl,
    });
    expect(res.available).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });
});

describe("autoRegisterIfDetected", () => {
  it("writes a config + key file when none exist", async () => {
    const configPath = path.join(tmpDir, "config.json");
    const keyFilePath = path.join(tmpDir, "vllm-api-key");
    const result = await autoRegisterIfDetected({
      configPath,
      keyFilePath,
      detection: { available: true, model: "Qwen/Qwen2.5-14B-Instruct-AWQ" },
    });
    expect(result.status).toBe("registered");

    const config = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      copilot: { provider: { type: string; baseUrl: string; apiKey: string; model: string } };
    };
    expect(config.copilot.provider.type).toBe("openai");
    expect(config.copilot.provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(config.copilot.provider.model).toBe("Qwen/Qwen2.5-14B-Instruct-AWQ");
    // 32 bytes -> 43 chars base64url (no padding).
    expect(config.copilot.provider.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const keyFile = (await fs.readFile(keyFilePath, "utf-8")).trim();
    expect(keyFile).toBe(config.copilot.provider.apiKey);

    if (process.platform !== "win32") {
      const cfgStat = await fs.stat(configPath);
      expect(cfgStat.mode & 0o777).toBe(0o600);
      const keyStat = await fs.stat(keyFilePath);
      expect(keyStat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not overwrite an existing provider for the same baseUrl", async () => {
    const configPath = path.join(tmpDir, "config.json");
    const keyFilePath = path.join(tmpDir, "vllm-api-key");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          copilot: {
            provider: {
              type: "openai",
              baseUrl: "http://127.0.0.1:8000/v1",
              apiKey: "user-supplied-do-not-touch",
            },
          },
        },
        null,
        2,
      ),
    );
    const result = await autoRegisterIfDetected({
      configPath,
      keyFilePath,
      detection: { available: true, model: "any" },
    });
    expect(result.status).toBe("already-configured");
    const config = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      copilot: { provider: { apiKey: string } };
    };
    expect(config.copilot.provider.apiKey).toBe("user-supplied-do-not-touch");
    await expect(fs.access(keyFilePath)).rejects.toBeTruthy();
  });

  it("returns skipped-undetected when probe failed", async () => {
    const result = await autoRegisterIfDetected({
      configPath: path.join(tmpDir, "config.json"),
      keyFilePath: path.join(tmpDir, "vllm-api-key"),
      detection: { available: false, error: "nope" },
    });
    expect(result.status).toBe("skipped-undetected");
  });

  it("returns skipped-disabled when enabled=false", async () => {
    const result = await autoRegisterIfDetected({
      enabled: false,
      configPath: path.join(tmpDir, "config.json"),
      keyFilePath: path.join(tmpDir, "vllm-api-key"),
      detection: { available: true },
    });
    expect(result.status).toBe("skipped-disabled");
  });

  it("never logs the API key", async () => {
    const configPath = path.join(tmpDir, "config.json");
    const keyFilePath = path.join(tmpDir, "vllm-api-key");
    const info = vi.fn();
    const warn = vi.fn();
    await autoRegisterIfDetected({
      configPath,
      keyFilePath,
      detection: { available: true, model: "m" },
      logger: { info, warn },
    });
    const key = (await fs.readFile(keyFilePath, "utf-8")).trim();
    const allCalls = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(allCalls).not.toContain(key);
  });

  it("uses the injected RNG (verifies crypto.randomBytes contract)", async () => {
    const configPath = path.join(tmpDir, "config.json");
    const keyFilePath = path.join(tmpDir, "vllm-api-key");
    const fakeBytes = Buffer.alloc(32, 7);
    const result = await autoRegisterIfDetected({
      configPath,
      keyFilePath,
      detection: { available: true, model: "m" },
      randomBytesImpl: (size) => {
        expect(size).toBe(32);
        return fakeBytes;
      },
    });
    expect(result.status).toBe("registered");
    expect(result.keyByteLength).toBe(32);
    const config = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      copilot: { provider: { apiKey: string } };
    };
    expect(config.copilot.provider.apiKey).toBe(fakeBytes.toString("base64url"));
  });
});
