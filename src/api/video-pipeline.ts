/**
 * Video Pipeline API — Clip extraction, reframing, audio cleaning, B-Roll, NLE export.
 * Issues #817-#828: OpusClip Feature Parity.
 */

import { Router } from "express";
import * as z from "zod";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { logger } from "../logging/logger.js";
import type { ClipExtractor } from "../video/clip-extractor.js";
import type { ReframeWorker } from "../video/reframe-worker.js";
import type { AudioCleaner } from "../video/audio-cleaner.js";
import type { BRollPipeline } from "../video/broll-pipeline.js";
import {
  getCaptionTemplateIds,
  getCaptionTemplate,
} from "../video/caption-templates.js";
import {
  manifestToTimeline,
  exportFCPXML,
  exportEDL,
  type DirectorManifestForExport,
} from "../video/nle-export.js";

// ── Schemas ─────────────────────────────────────────────────

const clipRequestSchema = z.object({
  source: z.string().min(1),
  prompt: z.string().optional(),
  mode: z.enum(["auto", "prompt"]).default("auto"),
  clipCount: z.number().min(1).max(50).default(10),
  minDuration: z.number().min(5).default(15),
  maxDuration: z.number().min(10).default(90),
  style: z
    .enum(["react", "highlight", "summarize", "teaser"])
    .default("highlight"),
});

const reframeRequestSchema = z.object({
  source: z.string().min(1),
  targetAspect: z.enum(["9:16", "1:1", "16:9", "4:5"]),
  layout: z
    .enum(["auto", "single-speaker", "split-screen", "gameplay", "action"])
    .default("auto"),
  smoothing: z.number().min(0).max(1).default(0.7),
});

const cleanAudioRequestSchema = z.object({
  source: z.string().min(1),
  removeFiller: z.boolean().default(true),
  trimSilence: z.boolean().default(true),
  maxSilenceDuration: z.number().min(0.1).max(5).default(0.5),
  aggressiveness: z
    .enum(["gentle", "moderate", "aggressive"])
    .default("moderate"),
  enhanceSpeech: z.boolean().default(false),
  deNoise: z.boolean().default(false),
});

const brollRequestSchema = z.object({
  source: z.string().min(1),
  mode: z.enum(["auto", "suggest", "custom"]).default("suggest"),
  density: z.enum(["sparse", "moderate", "dense"]).default("moderate"),
  transitionStyle: z
    .enum(["crossfade", "cut", "zoom", "slide"])
    .default("crossfade"),
});

const exportRequestSchema = z.object({
  manifest: z.record(z.unknown()),
  format: z.enum(["fcpxml", "edl"]),
  title: z.string().optional(),
});

// ── Factory ─────────────────────────────────────────────────

export interface VideoPipelineRouterOptions {
  clipExtractor?: ClipExtractor;
  reframeWorker?: ReframeWorker;
  audioCleaner?: AudioCleaner;
  brollPipeline?: BRollPipeline;
}

export const createVideoPipelineRouter = (
  options: VideoPipelineRouterOptions,
): Router => {
  const router = Router();

  // ── POST /clip — Extract clips from a video ──
  if (options.clipExtractor) {
    const clipExtractor = options.clipExtractor;

    router.post("/clip", async (req, res) => {
      try {
        const input = clipRequestSchema.parse(req.body);
        const jobId = await clipExtractor.submit({
          source: input.source,
          prompt: input.prompt,
          mode: input.mode,
          clipCount: input.clipCount,
          duration: { min: input.minDuration, max: input.maxDuration },
          style: input.style,
        });
        res.json({ jobId, status: "queued" });
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).json({ error: err.errors });
        } else {
          logger.error("[VideoPipeline] clip error:", err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });

    router.get("/clip/:jobId", (req, res) => {
      const job = clipExtractor.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    });
  }

  // ── POST /reframe — Reframe video to new aspect ratio ──
  if (options.reframeWorker) {
    const reframeWorker = options.reframeWorker;

    router.post("/reframe", async (req, res) => {
      try {
        const input = reframeRequestSchema.parse(req.body);
        const jobId = await reframeWorker.submit(input);
        res.json({ jobId, status: "queued" });
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).json({ error: err.errors });
        } else {
          logger.error("[VideoPipeline] reframe error:", err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });

    router.get("/reframe/:jobId", (req, res) => {
      const job = reframeWorker.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    });
  }

  // ── POST /clean-audio — Remove fillers and silence ──
  if (options.audioCleaner) {
    const audioCleaner = options.audioCleaner;

    router.post("/clean-audio", async (req, res) => {
      try {
        const input = cleanAudioRequestSchema.parse(req.body);
        const jobId = await audioCleaner.submit(input);
        res.json({ jobId, status: "queued" });
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).json({ error: err.errors });
        } else {
          logger.error("[VideoPipeline] clean-audio error:", err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });

    router.get("/clean-audio/:jobId", (req, res) => {
      const job = audioCleaner.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    });
  }

  // ── POST /broll — Auto B-Roll suggestions ──
  if (options.brollPipeline) {
    const brollPipeline = options.brollPipeline;

    router.post("/broll", async (req, res) => {
      try {
        const input = brollRequestSchema.parse(req.body);
        const jobId = await brollPipeline.submit(input);
        res.json({ jobId, status: "queued" });
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).json({ error: err.errors });
        } else {
          logger.error("[VideoPipeline] broll error:", err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });

    router.get("/broll/:jobId", (req, res) => {
      const job = brollPipeline.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    });
  }

  // ── GET /caption-templates — List available caption templates ──
  router.get("/caption-templates", (_req, res) => {
    const templates = getCaptionTemplateIds().map((id) => ({
      id,
      ...getCaptionTemplate(id),
    }));
    res.json({ templates });
  });

  // ── POST /export — Export manifest to FCP XML or EDL ──
  router.post("/export", (req, res) => {
    try {
      const input = exportRequestSchema.parse(req.body);
      const manifest = input.manifest as DirectorManifestForExport;
      const timeline = manifestToTimeline(manifest, input.title);
      const output =
        input.format === "fcpxml"
          ? exportFCPXML(timeline)
          : exportEDL(timeline);

      const ext = input.format === "fcpxml" ? ".xml" : ".edl";
      const exportDir = path.join(os.homedir(), ".openzigs", "exports");
      fs.mkdirSync(exportDir, { recursive: true });
      const sanitizedName = timeline.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const outputPath = path.join(
        exportDir,
        `${sanitizedName}_${Date.now()}${ext}`,
      );
      fs.writeFileSync(outputPath, output, "utf-8");

      res.json({
        status: "complete",
        format: input.format,
        outputPath,
        clips: timeline.clips.filter((c) => c.type === "video").length,
        transitions: timeline.transitions.length,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors });
      } else {
        logger.error("[VideoPipeline] export error:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return router;
};
