/**
 * Orchestration Template API routes.
 *
 * Mounted at /api/admin/orchestration — provides CRUD and execution
 * endpoints for multi-agent orchestration templates.
 */

import { Router } from "express";
import type { TemplateService } from "../orchestration/template-service.js";
import { logger } from "../logging/logger.js";
import { ZodError } from "zod";

export type OrchestrationRouterOptions = {
  templateService: TemplateService;
};

export const createOrchestrationRouter = ({
  templateService,
}: OrchestrationRouterOptions): Router => {
  const router = Router();

  // ── GET / — List all templates ──
  router.get("/", (_req, res) => {
    try {
      const templates = templateService.list();
      res.json({ templates });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to list orchestration templates", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /:id — Get a single template ──
  router.get("/:id", (req, res) => {
    try {
      const template = templateService.getById(req.params.id);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(template);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to get orchestration template", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ── POST / — Create a new template ──
  router.post("/", (req, res) => {
    try {
      const template = templateService.create(req.body);
      res.status(201).json(template);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: "Validation failed", details: error.errors });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to create orchestration template", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ── PUT /:id — Update a template ──
  router.put("/:id", (req, res) => {
    try {
      const template = templateService.update(req.params.id, req.body);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(template);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: "Validation failed", details: error.errors });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to update orchestration template", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ── DELETE /:id — Delete a template ──
  router.delete("/:id", (req, res) => {
    try {
      const deleted = templateService.delete(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Template not found or is built-in" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to delete orchestration template", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/execute — Execute a template ──
  router.post("/:id/execute", (req, res) => {
    try {
      const result = templateService.execute(req.params.id, req.body);
      res.json(result);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: "Validation failed", details: error.errors });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
        return;
      }
      logger.error("Failed to execute orchestration template", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
