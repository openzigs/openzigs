/**
 * Character API — CRUD + LoRA training management for character profiles.
 * Issue #377: Backend Training Service for LoRA character consistency.
 */

import { Router } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../logging/logger.js";
import type { CharacterRepository, CharacterCreate, CharacterUpdate } from "../characters/character-repository.js";

// ── Types ───────────────────────────────────────────────────

export interface CharacterRouterDeps {
  characterRepo: CharacterRepository;
}

// ── Storage Config ──────────────────────────────────────────

function getCharactersDir(): string {
  return path.join(os.homedir(), ".openzigs", "characters");
}

function getPhotosDir(characterId: string): string {
  return path.join(getCharactersDir(), characterId, "photos");
}

// Multer for reference photo uploads — 20MB per file, max 20 files
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      // Destination set per-request in the route handler via req.params
      const dir = path.join(os.tmpdir(), "openzigs-char-uploads");
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, safeName);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: ${allowed.join(", ")}`));
    }
  },
});

// ── Factory ─────────────────────────────────────────────────

export function createCharacterRouter({ characterRepo }: CharacterRouterDeps): Router {
  const router = Router();

  // ── GET / — List all characters ───────────────────────────
  router.get("/", (_req, res) => {
    try {
      const characters = characterRepo.getAll();
      res.json({ characters });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] Failed to list characters: ${msg}`);
      res.status(500).json({ error: "Failed to list characters" });
    }
  });

  // ── GET /:id — Get character by ID ────────────────────────
  router.get("/:id", (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      res.json(character);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] Failed to get character: ${msg}`);
      res.status(500).json({ error: "Failed to get character" });
    }
  });

  // ── POST / — Create a new character ───────────────────────
  router.post("/", (req, res) => {
    try {
      const body = req.body as Partial<CharacterCreate>;

      if (!body.name?.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!body.triggerWord?.trim()) {
        res.status(400).json({ error: "triggerWord is required" });
        return;
      }

      const input: CharacterCreate = {
        name: body.name.trim(),
        triggerWord: body.triggerWord.trim(),
        referencePhotos: body.referencePhotos ?? [],
        loraScale: body.loraScale ?? 0.8,
        trainingConfig: body.trainingConfig,
      };

      const character = characterRepo.create(input);
      logger.info(`[Characters] Created character '${character.name}' (${character.id})`);
      res.status(201).json(character);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("UNIQUE constraint failed")) {
        res.status(409).json({ error: "A character with that name already exists" });
        return;
      }
      logger.error(`[Characters] Failed to create character: ${msg}`);
      res.status(500).json({ error: "Failed to create character" });
    }
  });

  // ── PUT /:id — Update a character ─────────────────────────
  router.put("/:id", (req, res) => {
    try {
      const body = req.body as Partial<CharacterUpdate>;
      const updated = characterRepo.update(req.params.id, body);
      if (!updated) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      logger.info(`[Characters] Updated character '${updated.name}' (${updated.id})`);
      res.json(updated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("UNIQUE constraint failed")) {
        res.status(409).json({ error: "A character with that name already exists" });
        return;
      }
      logger.error(`[Characters] Failed to update character: ${msg}`);
      res.status(500).json({ error: "Failed to update character" });
    }
  });

  // ── DELETE /:id — Delete a character ──────────────────────
  router.delete("/:id", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }

      // Delete associated files (photos, LoRA weights)
      const charDir = path.join(getCharactersDir(), req.params.id);
      try {
        await fs.rm(charDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; DB record is still removed
      }

      characterRepo.delete(req.params.id);
      logger.info(`[Characters] Deleted character '${character.name}' (${character.id})`);
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] Failed to delete character: ${msg}`);
      res.status(500).json({ error: "Failed to delete character" });
    }
  });

  // ── POST /:id/photos — Upload reference photos ───────────
  router.post("/:id/photos", upload.array("photos", 20), async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files uploaded" });
        return;
      }

      // Move uploaded files to character's photos directory
      const photosDir = getPhotosDir(req.params.id);
      await fs.mkdir(photosDir, { recursive: true });

      const newPhotoPaths: string[] = [];
      for (const file of files) {
        const destPath = path.join(photosDir, file.filename);
        await fs.rename(file.path, destPath);
        newPhotoPaths.push(destPath);
      }

      // Append to existing photos
      const allPhotos = [...character.referencePhotos, ...newPhotoPaths];
      characterRepo.update(req.params.id, { referencePhotos: allPhotos });

      logger.info(`[Characters] Uploaded ${files.length} photos for '${character.name}'`);
      res.json({ uploaded: newPhotoPaths.length, totalPhotos: allPhotos.length, paths: newPhotoPaths });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] Failed to upload photos: ${msg}`);
      res.status(500).json({ error: "Failed to upload photos" });
    }
  });

  // ── GET /:id/photos/:filename — Serve a reference photo ──
  router.get("/:id/photos/:filename", async (req, res) => {
    try {
      const filePath = path.join(getPhotosDir(req.params.id), req.params.filename);
      // Security: ensure the resolved path stays within the expected directory
      const resolvedPath = path.resolve(filePath);
      const expectedDir = path.resolve(getPhotosDir(req.params.id));
      if (!resolvedPath.startsWith(expectedDir)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      await fs.access(filePath);
      res.sendFile(filePath);
    } catch {
      res.status(404).json({ error: "Photo not found" });
    }
  });

  // ── DELETE /:id/photos — Remove specific photos ───────────
  router.delete("/:id/photos", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }

      const { paths } = req.body as { paths?: string[] };
      if (!paths || !Array.isArray(paths) || paths.length === 0) {
        res.status(400).json({ error: "paths array is required" });
        return;
      }

      // Remove files from disk
      for (const photoPath of paths) {
        // Security: ensure the path is within the character's photos directory
        const resolvedPath = path.resolve(photoPath);
        const expectedDir = path.resolve(getPhotosDir(req.params.id));
        if (resolvedPath.startsWith(expectedDir)) {
          try {
            await fs.unlink(resolvedPath);
          } catch {
            // File may already be gone
          }
        }
      }

      // Update DB
      const remaining = character.referencePhotos.filter((p) => !paths.includes(p));
      characterRepo.update(req.params.id, { referencePhotos: remaining });

      res.json({ removed: paths.length, remaining: remaining.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] Failed to remove photos: ${msg}`);
      res.status(500).json({ error: "Failed to remove photos" });
    }
  });

  // ── POST /:id/train — Start LoRA training ─────────────────
  router.post("/:id/train", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }

      if (character.status === "training") {
        res.status(409).json({ error: "Training is already in progress for this character" });
        return;
      }

      if (character.referencePhotos.length < 5) {
        res.status(400).json({
          error: `At least 5 reference photos required for training. Currently have ${character.referencePhotos.length}.`,
        });
        return;
      }

      // Resolve the image-gen sidecar URL from config
      const sidecarUrl = await getImageGenSidecarUrl();
      if (!sidecarUrl) {
        res.status(503).json({
          error: "Image generation sidecar not configured. Set imageGen.networkNodeUrl in config or IMAGE_GEN_NETWORK_URL env var.",
        });
        return;
      }

      // Parse optional training overrides from request body
      const overrides = req.body as Record<string, unknown>;
      const steps = typeof overrides.steps === "number" ? overrides.steps : 1000;
      const learningRate = typeof overrides.learningRate === "number" ? overrides.learningRate : 1e-4;
      const loraRank = typeof overrides.loraRank === "number" ? overrides.loraRank : 4;

      // Read photos as base64 for sending to remote sidecar
      const photos: Array<{ image_base64: string; filename: string; prompt: string }> = [];
      for (const photoPath of character.referencePhotos) {
        try {
          const data = await fs.readFile(photoPath);
          photos.push({
            image_base64: data.toString("base64"),
            filename: path.basename(photoPath),
            prompt: `A photo of ${character.triggerWord}`,
          });
        } catch (err) {
          logger.warn(`[Characters] Skipping unreadable photo: ${photoPath}`);
        }
      }

      if (photos.length < 5) {
        res.status(400).json({
          error: `Only ${photos.length} photos readable on disk. Need at least 5.`,
        });
        return;
      }

      const trainConfig = {
        model: "dev",
        trigger_word: character.triggerWord,
        steps,
        learning_rate: learningRate,
        lora_rank: loraRank,
      };

      // Update status to training
      characterRepo.update(character.id, {
        status: "training",
        trainingConfig: trainConfig,
        errorMessage: null,
      });

      // POST to the image-gen sidecar's /train endpoint
      startRemoteTraining(character.id, sidecarUrl, trainConfig, photos, characterRepo);

      logger.info(`[Characters] Started LoRA training for '${character.name}' (${character.id}) via ${sidecarUrl}`);
      res.json({
        ok: true,
        message: `Training started for '${character.name}'`,
        sidecarUrl,
        steps,
        learningRate,
        loraRank,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] Failed to start training: ${msg}`);
      res.status(500).json({ error: "Failed to start training" });
    }
  });

  return router;
}

// ── Image-Gen Sidecar Config ────────────────────────────────

async function getImageGenSidecarUrl(): Promise<string | null> {
  // Check env vars first
  const envUrl = process.env.IMAGE_GEN_NETWORK_URL || process.env.IMAGE_GEN_SIDECAR_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");

  // Check user config
  try {
    const configPath = process.env.OPENZIGS_CONFIG_PATH
      ?? path.join(os.homedir(), ".openzigs", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ig = parsed.imageGen as Record<string, unknown> | undefined;
    if (ig?.networkNodeUrl && typeof ig.networkNodeUrl === "string") {
      return ig.networkNodeUrl.replace(/\/$/, "");
    }
  } catch {
    // Config unavailable
  }

  // Fallback to default local sidecar
  return "http://127.0.0.1:5005";
}

async function getImageGenToken(): Promise<string> {
  const envToken = process.env.IMAGE_GEN_NETWORK_TOKEN;
  if (envToken) return envToken;

  try {
    const configPath = process.env.OPENZIGS_CONFIG_PATH
      ?? path.join(os.homedir(), ".openzigs", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ig = parsed.imageGen as Record<string, unknown> | undefined;
    if (ig?.networkNodeToken && typeof ig.networkNodeToken === "string") {
      return ig.networkNodeToken;
    }
  } catch {
    // Config unavailable
  }
  return "";
}

// ── Remote Training Manager ─────────────────────────────────

async function startRemoteTraining(
  characterId: string,
  sidecarUrl: string,
  trainConfig: Record<string, unknown>,
  photos: Array<{ image_base64: string; filename: string; prompt: string }>,
  characterRepo: CharacterRepository,
): Promise<void> {
  const token = await getImageGenToken();

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const body = JSON.stringify({
      train_config: trainConfig,
      photos,
      character_id: characterId,
    });

    logger.info(`[Characters] Sending ${photos.length} photos to sidecar for training (${(body.length / 1024 / 1024).toFixed(1)} MB)`);

    const response = await fetch(`${sidecarUrl}/train`, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Sidecar returned ${response.status}: ${errText}`);
    }

    const result = await response.json() as { status: string; message: string; output_dir?: string };
    logger.info(`[Characters] Sidecar accepted training: ${result.message}`);

    // Start polling for completion
    pollTrainingStatus(characterId, sidecarUrl, token, result.output_dir ?? null, characterRepo);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    characterRepo.update(characterId, {
      status: "failed",
      errorMessage: `Failed to start remote training: ${msg}`,
    });
    logger.error(`[Characters] Remote training request failed for ${characterId}: ${msg}`);
  }
}

function pollTrainingStatus(
  characterId: string,
  sidecarUrl: string,
  token: string,
  _outputDir: string | null,
  characterRepo: CharacterRepository,
): void {
  const pollIntervalMs = 15_000; // 15 seconds
  const maxPollTimeMs = 4 * 60 * 60 * 1000; // 4 hours max
  const startTime = Date.now();

  const poll = async () => {
    if (Date.now() - startTime > maxPollTimeMs) {
      characterRepo.update(characterId, {
        status: "failed",
        errorMessage: "Training timed out after 4 hours",
      });
      logger.error(`[Characters] Training timed out for ${characterId}`);
      return;
    }

    try {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(`${sidecarUrl}/train-status`, { headers });
      if (!response.ok) {
        logger.warn(`[Characters] Train status poll failed: HTTP ${response.status}`);
        setTimeout(poll, pollIntervalMs);
        return;
      }

      const status = await response.json() as {
        training: boolean;
        error?: string;
        lora_path?: string;
        output_dir?: string;
      };

      if (status.training) {
        // Still training — poll again
        setTimeout(poll, pollIntervalMs);
        return;
      }

      // Training finished
      if (status.error) {
        characterRepo.update(characterId, {
          status: "failed",
          errorMessage: status.error,
        });
        logger.error(`[Characters] Remote training failed for ${characterId}: ${status.error}`);
      } else if (status.lora_path) {
        characterRepo.update(characterId, {
          status: "ready",
          trainedLoraPath: status.lora_path,
          errorMessage: null,
        });
        logger.info(`[Characters] Remote training complete for ${characterId}: ${status.lora_path}`);
      } else {
        characterRepo.update(characterId, {
          status: "failed",
          errorMessage: "Training completed but no LoRA adapter found in output directory",
        });
        logger.error(`[Characters] Remote training completed but no LoRA found for ${characterId}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Characters] Train status poll error for ${characterId}: ${msg}`);
      // Keep polling on transient errors
      setTimeout(poll, pollIntervalMs);
    }
  };

  setTimeout(poll, pollIntervalMs);
}
