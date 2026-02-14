/**
 * Knowledge Base admin API routes.
 *
 * Mounted at /api/admin/knowledge — provides CRUD and search endpoints
 * for the local knowledge base (RAG) subsystem.
 */

import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KnowledgeIngestionService } from "../knowledge/index.js";
import { logger } from "../logging/logger.js";

export type KnowledgeRouterOptions = {
  knowledgeService: KnowledgeIngestionService;
};

export const createKnowledgeRouter = ({ knowledgeService }: KnowledgeRouterOptions): Router => {
  const router = Router();

  const defaultConfigPath = () => process.env.OPENZIGS_CONFIG_PATH
    ?? path.join(os.homedir(), ".openzigs", "config.json");

  const readUserConfig = async (configPath: string): Promise<Record<string, unknown>> => {
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const writeUserConfig = async (configPath: string, data: Record<string, unknown>) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(configPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.chmod(configPath, 0o600);
  };

  // ── GET /stats — Knowledge base statistics ──
  router.get("/stats", async (_req, res) => {
    try {
      const stats = await knowledgeService.getStats();
      res.json(stats);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /documents — List all tracked documents ──
  router.get("/documents", (_req, res) => {
    try {
      const documents = knowledgeService.listDocuments();
      res.json({ documents });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /search — Semantic search over the knowledge base ──
  router.post("/search", async (req, res) => {
    try {
      const body = req.body as { query?: string; limit?: number };
      const query = typeof body.query === "string" ? body.query.trim() : "";
      const limit = typeof body.limit === "number" ? Math.min(body.limit, 50) : 10;

      if (!query) {
        res.status(400).json({ error: "Missing required field: query" });
        return;
      }

      const results = await knowledgeService.search(query, limit);
      res.json({ results, query, count: results.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /reindex — Force re-index all documents ──
  router.post("/reindex", async (_req, res) => {
    try {
      await knowledgeService.reindexAll();
      const stats = await knowledgeService.getStats();
      res.json({ ok: true, stats });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /reindex/:documentId — Force re-index a single document ──
  router.post("/reindex/:documentId", async (req, res) => {
    try {
      const { documentId } = req.params;
      await knowledgeService.reindexDocument(documentId);
      res.json({ ok: true, documentId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = msg.includes("not found") ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // ── DELETE /documents/:documentId — Remove a document from the knowledge base ──
  router.delete("/documents/:documentId", async (req, res) => {
    try {
      const { documentId } = req.params;
      await knowledgeService.deleteDocument(documentId);
      res.json({ ok: true, documentId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /config — Get knowledge base configuration ──
  router.get("/config", (_req, res) => {
    try {
      const config = knowledgeService.getConfig();
      res.json(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── PUT /config — Update knowledge configuration ──
  router.put("/config", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;

      const updates: Record<string, unknown> = {};

      if (body.directory !== undefined) {
        if (typeof body.directory !== "string" || body.directory.trim().length === 0) {
          res.status(400).json({ error: "directory must be a non-empty string" });
          return;
        }
        updates.directory = body.directory.trim();
      }

      if (body.watchEnabled !== undefined) {
        if (typeof body.watchEnabled !== "boolean") {
          res.status(400).json({ error: "watchEnabled must be a boolean" });
          return;
        }
        updates.watchEnabled = body.watchEnabled;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No valid knowledge config fields provided" });
        return;
      }

      // Apply live
      const appliedConfig = await knowledgeService.updateConfig(updates);

      // Persist user override
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existingKnowledge =
        userConfig.knowledge && typeof userConfig.knowledge === "object"
          ? (userConfig.knowledge as Record<string, unknown>)
          : {};

      userConfig.knowledge = {
        ...existingKnowledge,
        ...(updates.directory !== undefined ? { directory: appliedConfig.directory } : {}),
        ...(updates.watchEnabled !== undefined ? { watchEnabled: appliedConfig.watchEnabled } : {}),
      };

      await writeUserConfig(configPath, userConfig);

      logger.info(`[Knowledge] Config updated via API: ${Object.keys(updates).join(", ")}`);
      res.json({ ok: true, config: appliedConfig });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /converters — List available file converters ──
  router.get("/converters", (_req, res) => {
    try {
      const converters = knowledgeService.getConverterInfo();
      res.json({ converters });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /convert — Convert a file from an arbitrary path and ingest it ──
  router.post("/convert", async (req, res) => {
    try {
      const body = req.body as { filePath?: string; filePaths?: string[] };

      const paths: string[] = [];
      if (typeof body.filePath === "string" && body.filePath.trim()) {
        paths.push(body.filePath.trim());
      }
      if (Array.isArray(body.filePaths)) {
        for (const fp of body.filePaths) {
          if (typeof fp === "string" && fp.trim()) paths.push(fp.trim());
        }
      }

      if (paths.length === 0) {
        res.status(400).json({
          error: "Provide filePath (string) or filePaths (string[]) to convert",
        });
        return;
      }

      // Resolve ~ in paths
      const resolvedPaths = paths.map((p) => {
        if (p === "~") return os.homedir();
        if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
        return path.resolve(p);
      });

      // Copy each file into the knowledge directory, then let the watcher / scan pick it up
      const results: Array<{ file: string; ok: boolean; error?: string }> = [];

      const knowledgeDir = knowledgeService.getConfig().directory;

      for (const srcPath of resolvedPaths) {
        try {
          // Verify source exists
          await fs.access(srcPath);
          const fileName = path.basename(srcPath);
          const destPath = path.join(knowledgeDir, fileName);

          // Copy file to knowledge directory
          await fs.copyFile(srcPath, destPath);

          results.push({ file: fileName, ok: true });
          logger.info(`[Knowledge] Copied ${srcPath} → ${destPath} for conversion`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ file: path.basename(srcPath), ok: false, error: msg });
          logger.warn(`[Knowledge] Convert copy failed for ${srcPath}: ${msg}`);
        }
      }

      // Trigger a re-scan so newly copied files get indexed immediately
      await knowledgeService.reindexAll();

      const stats = await knowledgeService.getStats();
      res.json({ ok: true, results, stats });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
