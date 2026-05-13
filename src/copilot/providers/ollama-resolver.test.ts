import { describe, it, expect } from "vitest";
import {
  resolveOllamaTarget,
  resolveAndAssertOllamaTarget,
  OllamaTargetError,
} from "./ollama-resolver.js";

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

describe("resolveAndAssertOllamaTarget — SSRF guard (#1077 follow-up)", () => {
  it("local mode + loopback URL → passes", () => {
    const r = resolveAndAssertOllamaTarget(
      { mode: "local", localUrl: "http://127.0.0.1:11434" },
      {},
    );
    expect(r.mode).toBe("local");
    expect(r.baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("local mode + localhost name → passes", () => {
    const r = resolveAndAssertOllamaTarget(
      { mode: "local", localUrl: "http://localhost:11434" },
      {},
    );
    expect(r.baseUrl).toBe("http://localhost:11434");
  });

  it("local mode + non-loopback URL → throws local_url_not_loopback", () => {
    expect(() =>
      resolveAndAssertOllamaTarget(
        { mode: "local", localUrl: "http://10.0.0.42:11434" },
        {},
      ),
    ).toThrow(OllamaTargetError);
  });

  it("network mode + loopback URL → throws blocked_host", () => {
    try {
      resolveAndAssertOllamaTarget(
        { mode: "network", networkNodeUrl: "http://127.0.0.1:11434" },
        {},
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaTargetError);
      expect((err as OllamaTargetError).reason).toBe("blocked_host");
    }
  });

  it("network mode + cloud-metadata literal 169.254.169.254 → throws blocked_host", () => {
    try {
      resolveAndAssertOllamaTarget(
        {
          mode: "network",
          networkNodeUrl: "http://169.254.169.254/latest/meta-data/",
        },
        {},
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaTargetError);
      expect((err as OllamaTargetError).reason).toBe("blocked_host");
    }
  });

  it("network mode + 169.254.x link-local → throws blocked_host", () => {
    expect(() =>
      resolveAndAssertOllamaTarget(
        { mode: "network", networkNodeUrl: "http://169.254.10.5:11434" },
        {},
      ),
    ).toThrow(OllamaTargetError);
  });

  it("network mode + IPv6 link-local fe80:: → throws blocked_host", () => {
    expect(() =>
      resolveAndAssertOllamaTarget(
        { mode: "network", networkNodeUrl: "http://[fe80::1]:11434" },
        {},
      ),
    ).toThrow(OllamaTargetError);
  });

  it("network mode + RFC1918 10/8 → passes", () => {
    const r = resolveAndAssertOllamaTarget(
      { mode: "network", networkNodeUrl: "http://10.0.0.42:11434" },
      {},
    );
    expect(r.baseUrl).toBe("http://10.0.0.42:11434");
  });

  it("network mode + RFC1918 192.168/16 → passes", () => {
    const r = resolveAndAssertOllamaTarget(
      { mode: "network", networkNodeUrl: "http://192.168.1.10:11434" },
      {},
    );
    expect(r.baseUrl).toBe("http://192.168.1.10:11434");
  });

  it("network mode + .local mDNS hostname → passes", () => {
    const r = resolveAndAssertOllamaTarget(
      { mode: "network", networkNodeUrl: "http://workstation.local:11434" },
      {},
    );
    expect(r.baseUrl).toBe("http://workstation.local:11434");
  });

  it("network mode + public hostname → passes (DNS-rebinding documented out of scope)", () => {
    // The current guard intentionally permits public hostnames in network
    // mode (RFC1918 + .local + public are all "outside the host"). We pin
    // the behaviour here so a future tightening is an explicit decision.
    const r = resolveAndAssertOllamaTarget(
      { mode: "network", networkNodeUrl: "http://ollama.example.com:11434" },
      {},
    );
    expect(r.baseUrl).toBe("http://ollama.example.com:11434");
  });

  it("network mode with blank URL → throws missing_url (no silent loopback fallback)", () => {
    try {
      resolveAndAssertOllamaTarget({ mode: "network", networkNodeUrl: "" }, {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaTargetError);
      expect((err as OllamaTargetError).reason).toBe("missing_url");
    }
  });

  it("non-http scheme → throws invalid_url", () => {
    expect(() =>
      resolveAndAssertOllamaTarget(
        { mode: "network", networkNodeUrl: "file:///etc/passwd" },
        {},
      ),
    ).toThrow(OllamaTargetError);
  });
});
