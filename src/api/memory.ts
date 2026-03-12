/**
 * Admin API router for the GitHub-backed memory system.
 *
 * Mounted at `/api/admin/memory` in server.ts.
 *
 * @module api/memory
 * @see https://github.com/mgcronin/openzigs/issues/433
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { MemoryManager, MemoryCategory, MemoryConfig } from "../memory/memory-manager.js";
import { MEMORY_CATEGORIES } from "../memory/memory-manager.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const defaultConfigPath = () => process.env.OPENZIGS_CONFIG_PATH
  ?? path.join(os.homedir(), ".openzigs", "config.json");

const readUserConfig = async (configPath: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeUserConfig = async (configPath: string, data: Record<string, unknown>) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(configPath, 0o600);
};

export interface MemoryRouterDeps {
  memoryManager: MemoryManager;
}

export function createMemoryRouter({ memoryManager }: MemoryRouterDeps): Router {
  const router = Router();

  // ── Config ─────────────────────────────────────────────────────────

  /** GET /config — return current memory configuration + status */
  router.get("/config", async (_req: Request, res: Response) => {
    try {
      const config = memoryManager.getConfig();
      const status = await memoryManager.getStatus();
      res.json({ config, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** PUT /config — update memory configuration */
  router.put("/config", async (req: Request, res: Response) => {
    try {
      const { enabled, owner, repo, cacheTtlMs } = req.body as Partial<MemoryConfig>;
      const patch: Partial<MemoryConfig> = {};
      if (typeof enabled === "boolean") patch.enabled = enabled;
      if (typeof owner === "string") patch.owner = owner;
      if (typeof repo === "string") patch.repo = repo;
      if (typeof cacheTtlMs === "number" && cacheTtlMs > 0) patch.cacheTtlMs = cacheTtlMs;

      memoryManager.updateConfig(patch);

      // Persist to ~/.openzigs/config.json so config survives restarts
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existingMemory = (userConfig.memory && typeof userConfig.memory === "object")
        ? (userConfig.memory as Record<string, unknown>)
        : {};
      Object.assign(existingMemory, patch);
      userConfig.memory = existingMemory;
      await writeUserConfig(configPath, userConfig);

      const config = memoryManager.getConfig();
      res.json({ config });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Setup ──────────────────────────────────────────────────────────

  /** POST /setup — create memory repo on GitHub and initialise structure */
  router.post("/setup", async (_req: Request, res: Response) => {
    try {
      const result = await memoryManager.setupRepo();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Status ─────────────────────────────────────────────────────────

  /** GET /status — connection status, memory count, last sync */
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const status = await memoryManager.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Categories ─────────────────────────────────────────────────────

  /** GET /categories — list all memory categories */
  router.get("/categories", (_req: Request, res: Response) => {
    res.json({ categories: MEMORY_CATEGORIES });
  });

  // ── Memories CRUD ──────────────────────────────────────────────────

  /** GET /memories — list all memories (optionally filtered by category) */
  router.get("/memories", async (req: Request, res: Response) => {
    try {
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      let memories = await memoryManager.listMemories();
      if (category && MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
        memories = memories.filter((m) => m.category === category);
      }
      res.json({ memories });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** GET /memories/:id — get a single memory by its file path id */
  router.get("/memories/*", async (req: Request, res: Response): Promise<void> => {
    try {
      const id = (req.params as Record<string, string>)[0];
      if (!id) { res.status(400).json({ error: "Missing memory id" }); return; }

      const memory = await memoryManager.getMemory(id);
      if (!memory) { res.status(404).json({ error: "Memory not found" }); return; }
      res.json(memory);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** POST /memories — create a new memory */
  router.post("/memories", async (req: Request, res: Response): Promise<void> => {
    try {
      const { category, title, content } = req.body as { category?: string; title?: string; content?: string };
      if (!category || !MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
        res.status(400).json({ error: `Invalid category. Must be one of: ${MEMORY_CATEGORIES.join(", ")}` }); return;
      }
      if (!title || typeof title !== "string" || title.trim().length === 0) {
        res.status(400).json({ error: "Title is required" }); return;
      }
      if (!content || typeof content !== "string") {
        res.status(400).json({ error: "Content is required" }); return;
      }

      const memory = await memoryManager.createMemory({
        category: category as MemoryCategory,
        title: title.trim(),
        content,
      });
      res.status(201).json(memory);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** PUT /memories/:id — update a memory */
  router.put("/memories/*", async (req: Request, res: Response): Promise<void> => {
    try {
      const id = (req.params as Record<string, string>)[0];
      if (!id) { res.status(400).json({ error: "Missing memory id" }); return; }

      const { title, content } = req.body as { title?: string; content?: string };
      const memory = await memoryManager.updateMemory(id, {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
      });
      res.json(memory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  });

  /** DELETE /memories/:id — delete a memory */
  router.delete("/memories/*", async (req: Request, res: Response): Promise<void> => {
    try {
      const id = (req.params as Record<string, string>)[0];
      if (!id) { res.status(400).json({ error: "Missing memory id" }); return; }

      await memoryManager.deleteMemory(id);
      res.json({ deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
