import { Router } from "express";
import {
  BUILT_IN_TEMPLATES,
  type BrandTemplateRepository,
} from "../video/brand-templates.js";

export interface BrandTemplateRouterOptions {
  brandTemplateRepo: BrandTemplateRepository;
}

export function createBrandTemplateRouter({
  brandTemplateRepo,
}: BrandTemplateRouterOptions): Router {
  const router = Router();

  router.get("/builtin", (_req, res) => {
    try {
      res.json({ templates: BUILT_IN_TEMPLATES });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/", (req, res) => {
    try {
      const brandKitId = req.query.brandKitId as string | undefined;
      if (brandKitId) {
        res.json({ templates: brandTemplateRepo.listByBrandKit(brandKitId) });
      } else {
        res.json({ templates: [] });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const brandKitId = body.brandKitId as string | undefined;
      const templateDefId = body.templateDefId as string | undefined;

      if (!brandKitId || !templateDefId) {
        res
          .status(400)
          .json({ error: "brandKitId and templateDefId are required" });
        return;
      }

      const template = brandTemplateRepo.create({
        brandKitId,
        templateDefId,
        customTitle:
          typeof body.customTitle === "string" ? body.customTitle : undefined,
        customSubtitle:
          typeof body.customSubtitle === "string"
            ? body.customSubtitle
            : undefined,
        customDurationFrames:
          typeof body.customDurationFrames === "number"
            ? body.customDurationFrames
            : undefined,
        autoApply: typeof body.autoApply === "boolean" ? body.autoApply : false,
      });

      res.status(201).json({ template });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/:id", (req, res) => {
    try {
      const deleted = brandTemplateRepo.delete(req.params.id);
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

  return router;
}
