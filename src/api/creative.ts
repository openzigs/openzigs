/**
 * Creative Studio API routes — AI-powered inpainting via the media queue.
 * Issue #777: Inpainting workflows backed by Flux Kontext on the image-gen sidecar.
 */

import { Router } from "express";
import multer from "multer";
import { logger } from "../logging/logger.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";

export interface CreativeRouterOptions {
  mediaQueueRepo: MediaQueueRepository;
}

// Multer: accept image + mask files, 20 MB each
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

export function createCreativeRouter({
  mediaQueueRepo,
}: CreativeRouterOptions): Router {
  const router = Router();

  /**
   * POST /inpaint
   * Accepts multipart form: image (required), mask (optional), prompt (required), style_id (optional).
   * Queues an img2img job with flux-kontext model via the media queue.
   */
  router.post(
    "/inpaint",
    upload.fields([
      { name: "image", maxCount: 1 },
      { name: "mask", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as
          | Record<string, Express.Multer.File[]>
          | undefined;
        const imageFile = files?.["image"]?.[0];
        if (!imageFile) {
          res.status(400).json({ error: "image file is required" });
          return;
        }

        const prompt = (req.body as Record<string, string>).prompt?.trim();
        if (!prompt) {
          res.status(400).json({ error: "prompt is required" });
          return;
        }

        const MAX_PROMPT_LENGTH = 2000;
        if (prompt.length > MAX_PROMPT_LENGTH) {
          res.status(400).json({
            error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters`,
          });
          return;
        }

        const styleId = (req.body as Record<string, string>).style_id ?? "";

        // Convert uploaded image to base64
        const imageBase64 = imageFile.buffer.toString("base64");

        // Build prompt — prepend style instruction if specified
        const styledPrompt = styleId ? `${styleId} style: ${prompt}` : prompt;

        // Create an img2img queue job targeting flux-kontext
        const job = mediaQueueRepo.createJob({
          type: "img2img",
          payload: {
            prompt: styledPrompt,
            init_image: imageBase64,
            strength: 0.85,
          },
          model: "flux-kontext",
          priority: 1,
        });

        logger.info(
          `[CreativeRouter] Inpaint job queued: ${job.id} (prompt="${prompt.slice(0, 80)}")`,
        );

        res.status(202).json({
          jobId: job.id,
          status: job.status,
          message:
            "Inpainting job queued. Poll /api/queue/jobs/:id for status, or wait for the result in the Gallery.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[CreativeRouter] Inpaint error: ${msg}`);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
}
