/**
 * Character API — CRUD + LoRA training management for character profiles.
 * Issue #377: Backend Training Service for LoRA character consistency.
 */

import { Router } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
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

      // Parse optional training overrides from request body
      const overrides = req.body as Record<string, unknown>;
      const steps = typeof overrides.steps === "number" ? overrides.steps : 1000;
      const learningRate = typeof overrides.learningRate === "number" ? overrides.learningRate : 1e-4;
      const loraRank = typeof overrides.loraRank === "number" ? overrides.loraRank : 4;

      // Build the MFLUX DreamBooth training config
      const loraOutputDir = path.join(getCharactersDir(), character.id, "lora");
      await fs.mkdir(loraOutputDir, { recursive: true });

      const trainConfig = {
        model: "dev",
        output_dir: loraOutputDir,
        trigger_word: character.triggerWord,
        steps,
        learning_rate: learningRate,
        lora_rank: loraRank,
        examples: character.referencePhotos.map((p) => ({
          image_path: p,
          prompt: `A photo of ${character.triggerWord}`,
        })),
      };

      const configPath = path.join(getCharactersDir(), character.id, "train-config.json");
      await fs.writeFile(configPath, JSON.stringify(trainConfig, null, 2));

      // Update status to training
      characterRepo.update(character.id, {
        status: "training",
        trainingConfig: trainConfig,
        errorMessage: null,
      });

      // Spawn training process in background
      startTrainingProcess(character.id, configPath, loraOutputDir, characterRepo);

      logger.info(`[Characters] Started LoRA training for '${character.name}' (${character.id})`);
      res.json({
        ok: true,
        message: `Training started for '${character.name}'`,
        configPath,
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

// ── Training Process Manager ────────────────────────────────

function startTrainingProcess(
  characterId: string,
  configPath: string,
  loraOutputDir: string,
  characterRepo: CharacterRepository,
): void {
  logger.info(`[Characters] Spawning mflux-train for character ${characterId}`);

  const proc = spawn("mflux-train", ["--train-config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      logger.info(`[mflux-train:${characterId}] ${line}`);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
    const line = data.toString().trim();
    if (line) {
      logger.warn(`[mflux-train:${characterId}] stderr: ${line}`);
    }
  });

  proc.on("close", async (code) => {
    if (code === 0) {
      // Find the trained LoRA adapter file
      const loraPath = await findTrainedLora(loraOutputDir);
      if (loraPath) {
        characterRepo.update(characterId, {
          status: "ready",
          trainedLoraPath: loraPath,
          errorMessage: null,
        });
        logger.info(`[Characters] Training complete for ${characterId}: ${loraPath}`);
      } else {
        characterRepo.update(characterId, {
          status: "failed",
          errorMessage: "Training completed but no LoRA adapter found in output directory",
        });
        logger.error(`[Characters] Training completed but no LoRA found for ${characterId}`);
      }
    } else {
      const errorMsg = stderr.slice(-500) || `Process exited with code ${code}`;
      characterRepo.update(characterId, {
        status: "failed",
        errorMessage: errorMsg,
      });
      logger.error(`[Characters] Training failed for ${characterId}: exit code ${code}`);
    }
  });

  proc.on("error", (error) => {
    characterRepo.update(characterId, {
      status: "failed",
      errorMessage: `Failed to spawn training process: ${error.message}`,
    });
    logger.error(`[Characters] Training process error for ${characterId}: ${error.message}`);
  });
}

async function findTrainedLora(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { recursive: true }) as string[];
    // Look for .safetensors files (MFLUX LoRA output format)
    for (const entry of entries) {
      if (entry.endsWith(".safetensors")) {
        return path.join(dir, entry);
      }
    }
    // Also check for checkpoint zips
    for (const entry of entries) {
      if (entry.endsWith(".zip") && entry.includes("checkpoint")) {
        return path.join(dir, entry);
      }
    }
    return null;
  } catch {
    return null;
  }
}
