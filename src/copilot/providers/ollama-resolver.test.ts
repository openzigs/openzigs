import { describe, it, expect } from "vitest";
import { resolveOllamaTarget } from "./ollama-resolver.js";

describe("resolveOllamaTarget (#1077-B)", () => {
  it("defaults to local 11434 when no config + no env", () => {
    const r = resolveOllamaTarget(undefined, {});
    expect(r.mode).toBe("local");
    expect(r.baseUrl).toBe("http://127.0.0.1:11434");
    expect(r.headers).toEqual({});
  });

  it("uses config.localUrl in local mode", () => {
    const r = resolveOllamaTarget(
      { mode: "local", localUrl: "http://127.0.0.1:11500" },
      {},
    );
    expect(r.mode).toBe("local");
    expect(r.baseUrl).toBe("http://127.0.0.1:11500");
  });

  it("uses config.networkNodeUrl + token in network mode", () => {
    const r = resolveOllamaTarget(
      {
        mode: "network",
        networkNodeUrl: "http://10.0.0.42:11434",
        networkNodeToken: "shh",
      },
      {},
    );
    expect(r.mode).toBe("network");
    expect(r.baseUrl).toBe("http://10.0.0.42:11434");
    expect(r.headers).toEqual({ Authorization: "Bearer shh" });
  });

  it("omits Authorization header when network mode has no token", () => {
    const r = resolveOllamaTarget(
      {
        mode: "network",
        networkNodeUrl: "http://192.168.1.7:11434",
      },
      {},
    );
    expect(r.headers).toEqual({});
  });

  it("env OLLAMA_MODE/URL/TOKEN override config", () => {
    const r = resolveOllamaTarget(
      {
        mode: "local",
        localUrl: "http://127.0.0.1:11434",
        networkNodeUrl: "",
        networkNodeToken: "",
      },
      {
        OLLAMA_MODE: "network",
        OLLAMA_NETWORK_URL: "http://10.0.0.99:11434",
        OLLAMA_NETWORK_TOKEN: "envtok",
      },
    );
    expect(r.mode).toBe("network");
    expect(r.baseUrl).toBe("http://10.0.0.99:11434");
    expect(r.headers).toEqual({ Authorization: "Bearer envtok" });
  });

  it("ignores invalid OLLAMA_MODE values", () => {
    const r = resolveOllamaTarget(
      { mode: "local", localUrl: "http://127.0.0.1:11434" },
      { OLLAMA_MODE: "garbage" },
    );
    expect(r.mode).toBe("local");
  });

  it("falls back to local URL if network mode is selected but URL is blank", () => {
    const r = resolveOllamaTarget({ mode: "network", networkNodeUrl: "" }, {});
    expect(r.mode).toBe("network");
    expect(r.baseUrl).toBe("http://127.0.0.1:11434");
  });
});
