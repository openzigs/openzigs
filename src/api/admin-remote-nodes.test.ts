import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRemoteNodesRouter,
  buildNodeView,
  readUserConfig,
  writeUserConfig,
} from "./admin-remote-nodes.js";

let configPath: string;
let app: express.Express;

async function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => srv.close() });
    });
  });
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-rn-"));
  configPath = path.join(dir, "config.json");
});

afterEach(async () => {
  try {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// Fake DNS resolver: returns a public IP for example.com hosts and the
// literal RFC1918 address for 192.168.* hosts. Avoids real DNS in sandbox.
const fakeResolver = async (host: string) => {
  if (host.includes("192.168")) return [{ address: host, family: 4 }];
  return [{ address: "203.0.113.10", family: 4 }];
};

function buildApp(opts: { fetchImpl?: typeof fetch } = {}) {
  app = express();
  app.use(express.json());
  app.use(
    "/remote-nodes",
    createRemoteNodesRouter({
      configPath,
      fetchImpl: opts.fetchImpl,
      dnsResolver: fakeResolver,
    }),
  );
}

describe("buildNodeView", () => {
  it("returns empty url + masked token=false when nothing saved", () => {
    const v = buildNodeView("image-gen", {});
    expect(v).toEqual({
      nodeType: "image-gen",
      configKey: "imageGen",
      defaultPort: 5005,
      url: "",
      hasToken: false,
      tokenMask: "",
      allowLan: false,
      cfAccessClientId: "",
      hasCfAccessClientSecret: false,
    });
  });

  it("masks tokens and surfaces allowLan", () => {
    const v = buildNodeView("video-gen", {
      videoGen: {
        networkNodeUrl: "https://video.example.com",
        networkNodeToken: "supersecret",
        allowLan: true,
      },
    });
    expect(v.url).toBe("https://video.example.com");
    expect(v.hasToken).toBe(true);
    expect(v.tokenMask).toBe("••••••••");
    expect(v.allowLan).toBe(true);
  });

  it("exposes cfAccessClientId plain and masks cfAccessClientSecret", () => {
    const v = buildNodeView("video-gen", {
      videoGen: {
        networkNodeUrl: "https://video.example.com",
        cfAccessClientId: "client-id-123",
        cfAccessClientSecret: "super-cf-secret",
      },
    });
    expect(v.cfAccessClientId).toBe("client-id-123");
    expect(v.hasCfAccessClientSecret).toBe(true);
    expect(JSON.stringify(v)).not.toContain("super-cf-secret");
  });

  it("returns empty cfAccessClientId and hasCfAccessClientSecret=false when unset", () => {
    const v = buildNodeView("image-gen", {});
    expect(v.cfAccessClientId).toBe("");
    expect(v.hasCfAccessClientSecret).toBe(false);
  });
});

describe("createRemoteNodesRouter", () => {
  it("GET / lists every supported node", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/`);
    const body = (await r.json()) as { nodes: Array<{ nodeType: string }> };
    close();
    expect(body.nodes.map((n) => n.nodeType).sort()).toEqual(
      [
        "audio",
        "image-gen",
        "lip-sync",
        "music-gen",
        "rvc",
        "sad-talker",
        "video-gen",
      ].sort(),
    );
  });

  it("GET /:nodeType returns 404 for unknown type", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/bogus`);
    close();
    expect(r.status).toBe(404);
  });

  it("PUT /:nodeType saves a public URL with a token", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        token: "tok-123",
        allowLan: false,
      }),
    });
    const body = (await r.json()) as Record<string, unknown>;
    close();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.networkNodeUrl).toBe("https://images.example.com");
    expect(ig.networkNodeToken).toBe("tok-123");
    expect(ig.allowLan).toBe(false);
  });

  it("PUT /:nodeType rejects loopback URL with ssrf_blocked", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:5005" }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("ssrf_blocked");
  });

  it("PUT /:nodeType rejects RFC1918 URL when allowLan=false", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://192.168.68.60:5005",
        allowLan: false,
      }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("lan_not_allowed");
  });

  it("PUT /:nodeType accepts RFC1918 URL when allowLan=true", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://192.168.68.60:5005",
        allowLan: true,
      }),
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    expect((cfg.imageGen as Record<string, unknown>).allowLan).toBe(true);
  });

  it("PUT /:nodeType rejects non-http URL with 400", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com" }),
    });
    close();
    expect(r.status).toBe(400);
  });

  it("PUT /:nodeType rejects oversized token with 400 token_too_long", async () => {
    buildApp();
    const { port, close } = await listen();
    const oversized = "a".repeat(4097);
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        token: oversized,
      }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("token_too_long");
    const cfg = await readUserConfig(configPath);
    expect(cfg.imageGen).toBeUndefined();
  });

  it("PUT /:nodeType rejects oversized URL with 400 url_too_long", async () => {
    buildApp();
    const { port, close } = await listen();
    const oversizedUrl = `https://images.example.com/${"a".repeat(4097)}`;
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: oversizedUrl }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("url_too_long");
    const cfg = await readUserConfig(configPath);
    expect(cfg.imageGen).toBeUndefined();
  });

  it("DELETE /:nodeType clears saved fields", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://x.example.com",
        networkNodeToken: "t",
        allowLan: true,
      },
    });
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "DELETE",
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.networkNodeUrl).toBeUndefined();
    expect(ig.networkNodeToken).toBeUndefined();
    expect(ig.allowLan).toBeUndefined();
  });

  it("POST /:nodeType/test probes /health and /capabilities", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://probe.example.com",
        networkNodeToken: "tok",
        allowLan: false,
      },
    });
    const calls: string[] = [];
    const initOptions: RequestInit[] = [];
    const fakeFetch: typeof fetch = (async (
      input: unknown,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push(url);
      initOptions.push(init ?? {});
      const body = url.endsWith("/health")
        ? { status: "ok" }
        : { models: ["flux-dev"] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean };
      capabilities: { ok: boolean };
    };
    close();
    expect(r.status).toBe(200);
    expect(body.health.ok).toBe(true);
    expect(body.capabilities.ok).toBe(true);
    expect(calls).toEqual([
      "https://probe.example.com/health",
      "https://probe.example.com/capabilities",
    ]);
    expect(initOptions.map((init) => init.redirect)).toEqual([
      "manual",
      "manual",
    ]);
  });

  it("POST /:nodeType/test honors explicit unsaved allowLan=true", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "http://192.168.68.60:5005",
          allowLan: true,
        }),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean };
      capabilities: { ok: boolean };
    };
    close();
    expect(r.status).toBe(200);
    expect(body.health.ok).toBe(true);
    expect(body.capabilities.ok).toBe(true);
    expect(calls).toEqual([
      "http://192.168.68.60:5005/health",
      "http://192.168.68.60:5005/capabilities",
    ]);
  });

  it("POST /:nodeType/test caps oversized probe responses", async () => {
    await writeUserConfig(configPath, {
      imageGen: { networkNodeUrl: "https://large.example.com" },
    });
    const fakeFetch: typeof fetch = (async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      })) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean; error?: string };
      capabilities: { ok: boolean; error?: string };
    };
    close();
    expect(body.health.ok).toBe(false);
    expect(body.health.error).toContain("response too large");
    expect(body.capabilities.ok).toBe(false);
    expect(body.capabilities.error).toContain("response too large");
  });

  it("POST /:nodeType/test returns 400 when no URL configured", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    close();
    expect(r.status).toBe(400);
  });

  it("POST /:nodeType/test reports per-endpoint error when fetch fails", async () => {
    await writeUserConfig(configPath, {
      imageGen: { networkNodeUrl: "https://broken.example.com" },
    });
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean; error?: string };
      capabilities: { ok: boolean; error?: string };
    };
    close();
    expect(body.health.ok).toBe(false);
    expect(body.health.error).toContain("ECONNREFUSED");
    expect(body.capabilities.ok).toBe(false);
  });
});

describe("Cloudflare Access service-token support (#1100)", () => {
  it("PUT persists cfAccessClientId and cfAccessClientSecret", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        cfAccessClientId: "cf-id-abc",
        cfAccessClientSecret: "cf-sec-xyz",
      }),
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.cfAccessClientId).toBe("cf-id-abc");
    expect(ig.cfAccessClientSecret).toBe("cf-sec-xyz");
  });

  it("GET masks cfAccessClientSecret and surfaces hasCfAccessClientSecret", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://x.example.com",
        cfAccessClientId: "cf-id-abc",
        cfAccessClientSecret: "ultra-secret-value-do-not-leak",
      },
    });
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`);
    const text = await r.text();
    close();
    expect(r.status).toBe(200);
    expect(text).not.toContain("ultra-secret-value-do-not-leak");
    const body = JSON.parse(text) as {
      cfAccessClientId: string;
      hasCfAccessClientSecret: boolean;
    };
    expect(body.cfAccessClientId).toBe("cf-id-abc");
    expect(body.hasCfAccessClientSecret).toBe(true);
  });

  it("GET / never returns cfAccessClientSecret in any node entry", async () => {
    await writeUserConfig(configPath, {
      videoGen: {
        networkNodeUrl: "https://v.example.com",
        cfAccessClientSecret: "absolutely-confidential-cf-secret",
      },
    });
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/`);
    const text = await r.text();
    close();
    expect(text).not.toContain("absolutely-confidential-cf-secret");
  });

  it("PUT clears cfAccessClientId/Secret when empty string is sent", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://x.example.com",
        cfAccessClientId: "cf-id-abc",
        cfAccessClientSecret: "cf-sec-xyz",
      },
    });
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://x.example.com",
        cfAccessClientId: "",
        cfAccessClientSecret: "",
      }),
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.cfAccessClientId).toBeUndefined();
    expect(ig.cfAccessClientSecret).toBeUndefined();
  });

  it("DELETE clears cfAccessClientId and cfAccessClientSecret too", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://x.example.com",
        networkNodeToken: "t",
        cfAccessClientId: "cf-id-abc",
        cfAccessClientSecret: "cf-sec-xyz",
        allowLan: true,
      },
    });
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "DELETE",
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.cfAccessClientId).toBeUndefined();
    expect(ig.cfAccessClientSecret).toBeUndefined();
  });

  it("PUT rejects oversized cfAccessClientSecret with 400", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        cfAccessClientSecret: "a".repeat(4097),
      }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("cf_access_client_secret_too_long");
  });

  it("PUT rejects oversized cfAccessClientId with 400", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        cfAccessClientId: "a".repeat(4097),
      }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("cf_access_client_id_too_long");
  });

  it("Test probe sends Authorization + CF-Access-Client-* headers when fully configured", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://probe.example.com",
        networkNodeToken: "tok-bearer",
        cfAccessClientId: "cf-id-probe",
        cfAccessClientSecret: "cf-sec-probe",
      },
    });
    const captured: Array<Record<string, string>> = [];
    const fakeFetch: typeof fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      captured.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    close();
    expect(r.status).toBe(200);
    expect(captured.length).toBe(2);
    for (const h of captured) {
      expect(h["Authorization"]).toBe("Bearer tok-bearer");
      expect(h["CF-Access-Client-Id"]).toBe("cf-id-probe");
      expect(h["CF-Access-Client-Secret"]).toBe("cf-sec-probe");
    }
  });

  it("Test probe omits CF-Access-Client-* headers when not configured", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://probe.example.com",
        networkNodeToken: "tok-bearer",
      },
    });
    const captured: Array<Record<string, string>> = [];
    const fakeFetch: typeof fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      captured.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    close();
    expect(captured.length).toBe(2);
    for (const h of captured) {
      expect(h["Authorization"]).toBe("Bearer tok-bearer");
      expect(h["CF-Access-Client-Id"]).toBeUndefined();
      expect(h["CF-Access-Client-Secret"]).toBeUndefined();
    }
  });

  it("Test probe accepts CF Access creds from request body (unsaved)", async () => {
    await writeUserConfig(configPath, {
      imageGen: { networkNodeUrl: "https://probe.example.com" },
    });
    const captured: Array<Record<string, string>> = [];
    const fakeFetch: typeof fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      captured.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cfAccessClientId: "body-id",
        cfAccessClientSecret: "body-sec",
      }),
    });
    close();
    expect(captured[0]["CF-Access-Client-Id"]).toBe("body-id");
    expect(captured[0]["CF-Access-Client-Secret"]).toBe("body-sec");
  });
});
