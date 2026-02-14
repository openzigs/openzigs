/**
 * Knowledge Base admin API routes.
 *
 * Mounted at /api/admin/knowledge — provides CRUD and search endpoints
 * for the local knowledge base (RAG) subsystem.
 */

import { Router } from "express";
import type { KnowledgeIngestionService } from "../knowledge/index.js";

export type KnowledgeRouterOptions = {
  knowledgeService: KnowledgeIngestionService;
};

export const createKnowledgeRouter = ({ knowledgeService }: KnowledgeRouterOptions): Router => {
  const router = Router();

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

  return router;
};
