import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import type { webcrypto } from "node:crypto";

vi.mock("../logging/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  cfAccessGuard,
  _resetCache,
  _setFetchFn,
} from "./cloudflare-access.js";

// ── RSA Key Pair Generation ─────────────────────────────────

async function generateTestKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return keyPair;
}

function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jsonToBase64url(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createTestJwt(
  privateKey: webcrypto.CryptoKey,
  payload: Record<string, unknown>,
  kid: string,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = jsonToBase64url(header);
  const payloadB64 = jsonToBase64url(payload);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    signingInput,
  );
  const signatureB64 = arrayBufferToBase64url(signature);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

async function exportPublicKeyJwk(publicKey: webcrypto.CryptoKey) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return jwk;
}

// ── Tests ───────────────────────────────────────────────────

describe("cfAccessGuard", () => {
  let keyPair: webcrypto.CryptoKeyPair;
  let publicJwk: webcrypto.JsonWebKey;
  let fetchCallCount: number;

  beforeEach(async () => {
    _resetCache();
    fetchCallCount = 0;

    keyPair = await generateTestKeyPair();
    publicJwk = await exportPublicKeyJwk(keyPair.publicKey);

    _setFetchFn(async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          keys: [
            {
              kty: publicJwk.kty,
              kid: "test-key-1",
              n: publicJwk.n,
              e: publicJwk.e,
              alg: "RS256",
            },
          ],
        }),
        { status: 200 },
      );
    });
  });

  afterEach(() => {
    _setFetchFn(globalThis.fetch);
    _resetCache();
  });

  function createApp(config: {
    cfAccessTeamDomain?: string;
    cfAccessAudience?: string | string[];
  }) {
    const app = express();
    app.use(cfAccessGuard(config));
    app.get("/test", (_req, res) => {
      const email = (_req as unknown as Record<string, unknown>).cfAccessEmail;
      res.json({ ok: true, email: email ?? null });
    });
    return app;
  }

  it("passes through requests without CF headers", async () => {
    const app = createApp({ cfAccessTeamDomain: "openzigs" });
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetchCallCount).toBe(0);
  });

  it("validates and passes through requests with valid JWT", async () => {
    const app = createApp({ cfAccessTeamDomain: "openzigs" });
    const jwt = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        aud: "test-audience",
      },
      "test-key-1",
    );

    const res = await request(app)
      .get("/test")
      .set("CF-Access-JWT-Assertion", jwt);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("user@example.com");
  });

  it("rejects requests with expired JWT", async () => {
    const app = createApp({ cfAccessTeamDomain: "openzigs" });
    const jwt = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user@example.com",
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
        aud: "test-audience",
      },
      "test-key-1",
    );

    const res = await request(app)
      .get("/test")
      .set("CF-Access-JWT-Assertion", jwt);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Cloudflare Access validation failed");
  });

  it("rejects requests with invalid signature", async () => {
    const app = createApp({ cfAccessTeamDomain: "openzigs" });

    // Create a different key pair for signing (signature won't match JWKS)
    const otherKeyPair = await generateTestKeyPair();
    const jwt = await createTestJwt(
      otherKeyPair.privateKey,
      {
        email: "attacker@evil.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-key-1",
    );

    const res = await request(app)
      .get("/test")
      .set("CF-Access-JWT-Assertion", jwt);
    expect(res.status).toBe(403);
  });

  it("logs warning and allows through when team domain is not configured", async () => {
    const app = createApp({});
    const jwt = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-key-1",
    );

    const res = await request(app)
      .get("/test")
      .set("CF-Access-JWT-Assertion", jwt);
    expect(res.status).toBe(200);
    expect(fetchCallCount).toBe(0);
  });

  it("caches JWKS keys (second call does not re-fetch)", async () => {
    const app = createApp({ cfAccessTeamDomain: "openzigs" });

    const jwt1 = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user1@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-key-1",
    );

    const jwt2 = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user2@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-key-1",
    );

    await request(app).get("/test").set("CF-Access-JWT-Assertion", jwt1);
    await request(app).get("/test").set("CF-Access-JWT-Assertion", jwt2);

    expect(fetchCallCount).toBe(1); // Only fetched once
  });

  it("rejects JWT with wrong audience when audience is configured", async () => {
    const app = createApp({
      cfAccessTeamDomain: "openzigs",
      cfAccessAudience: "correct-audience",
    });

    const jwt = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        aud: "wrong-audience",
      },
      "test-key-1",
    );

    const res = await request(app)
      .get("/test")
      .set("CF-Access-JWT-Assertion", jwt);
    expect(res.status).toBe(403);
  });

  it("accepts JWT with matching audience", async () => {
    const app = createApp({
      cfAccessTeamDomain: "openzigs",
      cfAccessAudience: ["aud-a", "aud-b"],
    });

    const jwt = await createTestJwt(
      keyPair.privateKey,
      {
        email: "user@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        aud: "aud-b",
      },
      "test-key-1",
    );

    const res = await request(app)
      .get("/test")
      .set("CF-Access-JWT-Assertion", jwt);
    expect(res.status).toBe(200);
  });
});
