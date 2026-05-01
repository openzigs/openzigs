import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createApp } from "../app.js";
import { loadConfig, type AppConfig } from "../config/index.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-auth-"));
};

const closeServer = (server: Server) => {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const startServer = (config: AppConfig) => {
  const app = createApp(config);
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
};

describe("auth middleware", () => {
  const cleanupDirs: string[] = [];
  let configPath = "";

  beforeEach(async () => {
    const dir = await createTempDir();
    cleanupDirs.push(dir);
    configPath = path.join(dir, "config.json");
  });

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("generates a local token on first run", async () => {
    const config = await loadConfig({ configPath });
    expect(config.auth.token).toMatch(/^[a-f0-9]{64}$/i);

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { auth?: { token?: string } };
    expect(parsed.auth?.token).toBe(config.auth.token);
  });

  it("rejects requests without auth header", async () => {
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = startServer(config);

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("accepts valid bearer token", async () => {
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = startServer(config);

    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${config.auth.token}` }
      });
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("blocks viewer role from admin endpoints", async () => {
    const initialConfig = await loadConfig({ configPath });
    const viewerConfig: AppConfig = {
      ...initialConfig,
      auth: {
        ...initialConfig.auth,
        role: "viewer"
      }
    };

    const { server, baseUrl } = startServer(viewerConfig);

    try {
      const response = await fetch(`${baseUrl}/api/tools/test/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${initialConfig.auth.token}` }
      });

      expect(response.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it("rate limits repeated failed auth attempts", async () => {
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = startServer(config);

    try {
      let status = 0;
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/health`);
        status = response.status;
      }

      expect(status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });

  // ── Sub-issue #1011: pitch render path query-token allowlist ──
  // The Present button in the pitch admin renders an iframe whose `src`
  // points at `/api/admin/pitch/decks/<id>/render?token=<bearer>`. Iframes
  // cannot send `Authorization` headers, so the auth middleware must
  // accept a `?token=` query parameter for the render path \u2014 same
  // pattern as the asset-file allowlist established in PR #1003.
  //
  // These tests mount a minimal Express app with `createAuthMiddleware`
  // applied via `app.use(authMiddleware)` so we exercise the allowlist
  // regex in isolation \u2014 the full `createApp` does NOT register
  // `/api/admin/pitch/*` routes (those live in `server.ts`), and the
  // middleware is per-route there.
  describe("pitch render query-token allowlist (#1011)", () => {
    const startMiniServer = async (token: string | undefined) => {
      const express = (await import("express")).default;
      const { createAuthMiddleware } = await import("./auth.js");
      const app = express();
      const authMiddleware = createAuthMiddleware({
        mode: "local" as const,
        token: token ?? "",
        role: "admin" as const,
        rateLimit: { windowMs: 60_000, max: 100 },
      });
      app.use(authMiddleware);
      // Catch-all: if auth passes, return 200 so we can distinguish
      // "auth accepted" (200) from "auth rejected" (401).
      app.use((_req, res) => res.status(200).json({ ok: true }));
      const server = app.listen(0);
      const address = server.address() as AddressInfo;
      return { server, baseUrl: `http://127.0.0.1:${address.port}` };
    };

    it("accepts a valid ?token= query parameter on the render path", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMiniServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks/test-deck-123/render?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it("rejects an invalid ?token= query parameter on the render path", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMiniServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks/test-deck-123/render?token=wrong-token`,
        );
        expect(response.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });

    it("accepts ?token= on the render path with a sub-path (e.g. /render/style.css)", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMiniServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks/test-deck-123/render/style.css?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it("does NOT accept ?token= on a non-allowlisted admin path", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMiniServer(config.auth.token);
      try {
        // /api/admin/pitch/decks (no /render suffix) must still require
        // the bearer header \u2014 query token must be ignored.
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks?token=${config.auth.token}`,
        );
        expect(response.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── Issue #1012 regression: production mount point ──
  // PR #1013 added the pitch render allowlist but matched against
  // `req.path`, which Express strips of the mount prefix inside
  // sub-routers. In production `app.use("/api/admin", auth, adminRouter)`
  // makes `req.path` `/pitch/decks/.../render` — the regex (which
  // requires `/api/admin/...`) never matches and the request 401s.
  // This block mounts the auth middleware at `/api/admin` (matching
  // production) to lock in the fix.
  describe("pitch render allowlist behind /api/admin mount (#1012)", () => {
    const startMountedServer = async (token: string | undefined) => {
      const express = (await import("express")).default;
      const { createAuthMiddleware } = await import("./auth.js");
      const app = express();
      const authMiddleware = createAuthMiddleware({
        mode: "local" as const,
        token: token ?? "",
        role: "admin" as const,
        rateLimit: { windowMs: 60_000, max: 100 },
      });
      const router = express.Router();
      router.use((_req, res) => res.status(200).json({ ok: true }));
      app.use("/api/admin", authMiddleware, router);
      const server = app.listen(0);
      const address = server.address() as AddressInfo;
      return { server, baseUrl: `http://127.0.0.1:${address.port}` };
    };

    it("accepts ?token= on the render path when middleware is mounted at /api/admin", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks/test-deck-123/render?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it("accepts ?token= on a render sub-path when middleware is mounted at /api/admin", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks/test-deck-123/render/style.css?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it("still rejects ?token= on a non-allowlisted admin path when mounted at /api/admin", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks?token=${config.auth.token}`,
        );
        expect(response.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });

    it("accepts ?token= on pitch-generated asset URLs used by rendered slide iframes", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/admin/pitch/decks/test-deck-123/assets/asset-456?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── Issue #1012 regression (asset auth): mount-prefix encoding ──
  // The original asset regex was anchored at `^/assets/...` and matched
  // `req.path` (which Express strips of the mount prefix). When the fix
  // for the pitch render allowlist switched matching to `req.originalUrl`,
  // the asset regex had to be updated to encode its `/api/queue` mount
  // prefix — otherwise every UI <img>/<video> using `?token=` would 401.
  describe("asset file allowlist behind /api/queue mount (#1012)", () => {
    const startQueueMountedServer = async (token: string | undefined) => {
      const express = (await import("express")).default;
      const { createAuthMiddleware } = await import("./auth.js");
      const app = express();
      const authMiddleware = createAuthMiddleware({
        mode: "local" as const,
        token: token ?? "",
        role: "admin" as const,
        rateLimit: { windowMs: 60_000, max: 100 },
      });
      const router = express.Router();
      router.use((_req, res) => res.status(200).json({ ok: true }));
      app.use("/api/queue", authMiddleware, router);
      const server = app.listen(0);
      const address = server.address() as AddressInfo;
      return { server, baseUrl: `http://127.0.0.1:${address.port}` };
    };

    it("accepts ?token= on /api/queue/assets/:id/file when middleware is mounted at /api/queue", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startQueueMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/queue/assets/abc123/file?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it("accepts ?token= on /api/queue/assets/file/:filename when middleware is mounted at /api/queue", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startQueueMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/queue/assets/file/clip-001.mp4?token=${config.auth.token}`,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it("rejects an invalid ?token= on a /api/queue asset file path", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startQueueMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/queue/assets/abc123/file?token=wrong-token`,
        );
        expect(response.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });

    it("does NOT accept ?token= on a non-allowlisted /api/queue path (e.g. /api/queue/jobs)", async () => {
      const config = await loadConfig({ configPath });
      const { server, baseUrl } = await startQueueMountedServer(config.auth.token);
      try {
        const response = await fetch(
          `${baseUrl}/api/queue/jobs?token=${config.auth.token}`,
        );
        expect(response.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });
  });
});
