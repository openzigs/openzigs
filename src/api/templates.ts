/**
 * Post Template REST API — CRUD + apply endpoints for post templates.
 * Issue #809: Expose PostTemplateRepository via REST.
 */

import { Router } from "express";
import type {
  PostTemplate,
  PostTemplateRepository,
} from "../creative/post-template-repository.js";

export interface TemplatesRouterOptions {
  postTemplateRepo: PostTemplateRepository;
}

/** Serialize a PostTemplate to the REST API shape (snake_case). */
function serializeTemplate(t: PostTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    platform: t.platform,
    layout: t.layout,
    content_template: t.contentTemplate,
    brand_kit_id: t.brandKitId,
    tags: t.tags,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export function createTemplatesRouter({
  postTemplateRepo,
}: TemplatesRouterOptions): Router {
  const router = Router();

  /** GET / — list all templates (optional ?platform=xxx&brand_kit_id=xxx) */
  router.get("/", (req, res) => {
    try {
      const platform = req.query.platform as string | undefined;
      const brandKitId = req.query.brand_kit_id as string | undefined;
      const templates = postTemplateRepo.list({ platform, brandKitId });
      res.json({ templates: templates.map(serializeTemplate) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** POST / — create a template */
  router.post("/", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = body.name as string | undefined;
      const platform = body.platform as string | undefined;

      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!platform || typeof platform !== "string" || !platform.trim()) {
        res.status(400).json({ error: "platform is required" });
        return;
      }

      const template = postTemplateRepo.create({
        name: name.trim(),
        description:
          typeof body.description === "string" ? body.description : undefined,
        platform: platform.trim(),
        layout: typeof body.layout === "string" ? body.layout : "default",
        contentTemplate:
          typeof body.content_template === "string"
            ? body.content_template
            : "",
        brandKitId:
          typeof body.brand_kit_id === "string" ? body.brand_kit_id : null,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      });

      res.status(201).json(serializeTemplate(template));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** GET /:id — get by ID */
  router.get("/:id", (req, res) => {
    try {
      const template = postTemplateRepo.getById(req.params.id);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(serializeTemplate(template));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** PUT /:id — update template */
  router.put("/:id", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const updated = postTemplateRepo.update(req.params.id, {
        name: typeof body.name === "string" ? body.name : undefined,
        description:
          typeof body.description === "string" ? body.description : undefined,
        platform: typeof body.platform === "string" ? body.platform : undefined,
        layout: typeof body.layout === "string" ? body.layout : undefined,
        contentTemplate:
          typeof body.content_template === "string"
            ? body.content_template
            : undefined,
        brandKitId:
          body.brand_kit_id === null
            ? null
            : typeof body.brand_kit_id === "string"
              ? body.brand_kit_id
              : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      });

      if (!updated) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(serializeTemplate(updated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** DELETE /:id — delete template */
  router.delete("/:id", (req, res) => {
    try {
      const deleted = postTemplateRepo.delete(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /:id/apply — apply template with variables */
  router.post("/:id/apply", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const variables =
        body.variables && typeof body.variables === "object"
          ? (body.variables as Record<string, string>)
          : {};

      const result = postTemplateRepo.applyTemplate(req.params.id, variables);
      if (!result) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
