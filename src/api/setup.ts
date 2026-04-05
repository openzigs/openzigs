import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { execSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  secureDirOptions,
  secureWriteOptions,
} from "../config/file-permissions.js";
import { getPlatformCapabilities } from "../config/platform.js";
import { loadConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";

const router: Router = Router();

const OPENZIGS_DIR = path.join(os.homedir(), ".openzigs");
const CONFIG_PATH = path.join(OPENZIGS_DIR, "config.json");
const SETUP_COMPLETE_FLAG = path.join(OPENZIGS_DIR, ".setup-complete");

// Once setup is complete, config changes require authentication to prevent
// unauthenticated config overwrites via tunnels or exposed ports.
const setupAuthGate = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const isComplete = await fileExists(SETUP_COMPLETE_FLAG);
  if (!isComplete) {
    // First-time setup — allow without auth
    next();
    return;
  }

  // Setup is complete — require auth token
  let expectedToken = "";
  try {
    const config = await loadConfig();
    expectedToken = config.auth.token ?? "";
  } catch {
    // Config couldn't be loaded — reject to be safe
    res
      .status(500)
      .json({ error: "Could not load config for auth validation" });
    return;
  }

  if (!expectedToken) {
    // No token configured but setup is complete — reject
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expectedToken);
  if (
    tokenBuf.length !== expectedBuf.length ||
    !timingSafeEqual(tokenBuf, expectedBuf)
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};

// ── Helpers ────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function checkNodeVersion(): {
  ok: boolean;
  version: string;
  required: string;
} {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);
  return { ok: major >= 20, version, required: ">=20.0.0" };
}

function checkDocker(): { available: boolean; version: string | null } {
  try {
    const version = execSync("docker --version", {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

function checkGit(): { available: boolean; version: string | null } {
  try {
    const version = execSync("git --version", {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

// ── GET /api/setup/status ──────────────────────────────────

router.get("/status", async (_req, res) => {
  const isComplete = await fileExists(SETUP_COMPLETE_FLAG);
  const hasConfig = await fileExists(CONFIG_PATH);
  const hasEnv = await fileExists(path.join(process.cwd(), ".env"));

  res.json({
    setupComplete: isComplete,
    hasConfig,
    hasEnvFile: hasEnv,
    configPath: CONFIG_PATH,
  });
});

// ── GET /api/setup/prerequisites ───────────────────────────

router.get("/prerequisites", async (_req, res) => {
  const node = checkNodeVersion();
  const docker = checkDocker();
  const git = checkGit();
  const platform = await getPlatformCapabilities();

  res.json({
    node,
    docker,
    git,
    platform: {
      os: platform.os,
      arch: platform.arch,
      sidecarsSupported: platform.sidecarsSupported,
      chromePath: platform.chromePath,
    },
  });
});

// ── POST /api/setup/config ─────────────────────────────────
// Saves wizard selections to ~/.openzigs/config.json
// Merges with existing config (preserves keys not in the payload)

router.post("/config", setupAuthGate, async (req, res) => {
  try {
    const updates = req.body as Record<string, unknown>;
    if (!updates || typeof updates !== "object") {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }

    // Read existing config
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(CONFIG_PATH, "utf-8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No existing config — that's fine
    }

    // Deep merge (one level)
    for (const [key, value] of Object.entries(updates)) {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        existing[key] &&
        typeof existing[key] === "object" &&
        !Array.isArray(existing[key])
      ) {
        existing[key] = {
          ...(existing[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        existing[key] = value;
      }
    }

    // Write back
    await fs.mkdir(path.dirname(CONFIG_PATH), secureDirOptions());
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify(existing, null, 2),
      secureWriteOptions(),
    );

    res.json({ ok: true, configPath: CONFIG_PATH });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Setup config write failed: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ── POST /api/setup/complete ───────────────────────────────
// Marks setup as complete (writes a flag file)

router.post("/complete", setupAuthGate, async (_req, res) => {
  try {
    await fs.mkdir(OPENZIGS_DIR, secureDirOptions());
    await fs.writeFile(
      SETUP_COMPLETE_FLAG,
      new Date().toISOString(),
      secureWriteOptions(),
    );
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── POST /api/setup/reset ──────────────────────────────────
// Resets the setup-complete flag (allows re-running the wizard)

router.post("/reset", setupAuthGate, async (_req, res) => {
  try {
    await fs.unlink(SETUP_COMPLETE_FLAG).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
