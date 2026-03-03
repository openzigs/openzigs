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
import type { CopilotWrapperService } from "../copilot/copilot-wrapper.js";
import type { Server as SocketIOServer } from "socket.io";

// ── Types ───────────────────────────────────────────────────

export interface CharacterRouterDeps {
  characterRepo: CharacterRepository;
  copilot?: CopilotWrapperService;
}

// ── Socket.IO (injected after server init via setCharacterIO) ─
let _io: SocketIOServer | null = null;
export function setCharacterIO(io: SocketIOServer): void {
  _io = io;
}

// ── In-flight training cancellation flags ────────────────────
const _cancelledTraining = new Set<string>();

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

export function createCharacterRouter({ characterRepo, copilot }: CharacterRouterDeps): Router {
  const router = Router();

  // ── Startup: reset any characters stuck in "training" from a previous server run ──
  // The poll loop runs in-memory; on restart it dies and the status never clears.
  for (const char of characterRepo.getByStatus("training")) {
    characterRepo.update(char.id, {
      status: "failed",
      errorMessage: "Training was interrupted by a server restart",
    });
    logger.warn(`[Characters] Reset stale training status for '${char.name}' (${char.id})`);
  }

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
        description: typeof body.description === "string" ? body.description.trim() : "",
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
      const steps = typeof overrides.steps === "number" ? overrides.steps : 9;
      const learningRate = typeof overrides.learningRate === "number" ? overrides.learningRate : 1e-4;
      const loraRank = typeof overrides.loraRank === "number" ? overrides.loraRank : 8;
      const numEpochs = typeof overrides.numEpochs === "number" ? overrides.numEpochs : 10;

      // Build per-image prompt: use per-image caption if available,
      // fall back to character description, then generic trigger-word prompt
      const fallbackPrompt = character.description
        ? `A photo of ${character.triggerWord}, ${character.description}`
        : `A photo of ${character.triggerWord}`;

      const photos: Array<{ image_base64: string; filename: string; prompt: string }> = [];
      for (const photoPath of character.referencePhotos) {
        try {
          const data = await fs.readFile(photoPath);
          const filename = path.basename(photoPath);
          const caption = character.photoCaptions[filename];
          photos.push({
            image_base64: data.toString("base64"),
            filename,
            prompt: caption || fallbackPrompt,
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
        model: "z-image-turbo",
        trigger_word: character.triggerWord,
        steps,
        num_epochs: numEpochs,
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

  // ── POST /:id/cancel-training — Cancel an in-progress training run ──
  router.post("/:id/cancel-training", (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      if (character.status !== "training") {
        res.status(409).json({ error: "Character is not currently training" });
        return;
      }
      _cancelledTraining.add(req.params.id);
      characterRepo.update(req.params.id, {
        status: "failed",
        errorMessage: "Training cancelled by user",
      });
      _io?.emit("character:training:failed", { characterId: req.params.id, characterName: character.name });
      logger.info(`[Characters] Training cancelled for '${character.name}' (${req.params.id})`);
      res.json({ ok: true, message: "Training cancelled" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/ai-enhance — Auto-generate captions & suggest optimal params ──
  router.post("/:id/ai-enhance", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }

      const triggerWord = character.triggerWord;
      const desc = character.description;

      if (!desc) {
        res.status(400).json({
          error: "Please set a character description first (e.g. 'a husky dog with blue eyes'). The description is needed to generate meaningful training captions.",
        });
        return;
      }

      const photoCount = character.referencePhotos.length;
      const filenames = character.referencePhotos.map((p) => path.basename(p));

      if (!copilot) {
        // Fallback when copilot is unavailable — use simple varied templates
        const captions: Record<string, string> = {};
        for (let i = 0; i < filenames.length; i++) {
          captions[filenames[i]] = `A photo of ${triggerWord}, ${desc}`;
        }
        const suggestedEpochs = Math.max(5, Math.min(30, Math.round(150 / Math.max(1, photoCount))));
        res.json({
          captions,
          params: { epochs: suggestedEpochs, steps: 9, learningRate: 1e-4, loraRank: 8, loraScale: 0.85 },
          totalSteps: suggestedEpochs * photoCount,
        });
        return;
      }

      // Use the Copilot LLM to generate unique captions and suggest parameters
      const conversationId = `ai-enhance-${character.id}-${Date.now()}`;
      const systemMessage = `You are an expert at LoRA training for image generation models. You help create optimal training captions and parameters for Flux-based LoRA fine-tuning.

IMPORTANT RULES:
- Every caption MUST start with the exact trigger word "${triggerWord}" so the model learns to associate it with the subject.
- Every caption must be unique and describe the subject differently.
- Vary framing (close-up, portrait, full body, 3/4 view, profile), lighting (natural, studio, golden hour, overcast, backlit), setting (indoor, outdoor, park, studio backdrop), and quality descriptors.
- Keep captions concise (10-25 words each).
- Respond ONLY with valid JSON, no markdown fencing, no explanation.`;

      const userMessage = `Subject: "${desc}"
Trigger word: "${triggerWord}"
Number of reference photos: ${photoCount}
Photo filenames: ${JSON.stringify(filenames)}

Generate a JSON object with two keys:

1. "captions": an object mapping each filename to a unique training caption. Each caption must start with "${triggerWord}" and describe the subject in a different way (different framing, lighting, angle, setting, quality tags). Make every caption genuinely different — vary sentence structure, word order, and descriptive elements.

2. "params": an object with optimal LoRA training parameters for this subject:
   - "epochs": number of full passes (consider ${photoCount} photos — aim for 100-200 total steps)
   - "steps": inference steps during training (4-9 for distilled Flux models)
   - "learningRate": float (typically 1e-4 for LoRA)
   - "loraRank": 4, 8, 16, or 32 (consider subject complexity: simple styles→4, faces/animals→8, complex scenes→16)
   - "loraScale": inference-time LoRA strength (0.7-1.0)

Also include "reasoning": a brief explanation of why you chose those parameters.

Return only the raw JSON object.`;

      let fullResponse = "";
      try {
        for await (const chunk of copilot.chat(userMessage, {
          conversationId,
          systemMessage: { mode: "replace", content: systemMessage },
          tools: [],
          availableTools: [],
        })) {
          fullResponse += chunk;
        }
      } finally {
        await copilot.destroySession(conversationId).catch(() => {});
      }

      // Parse the LLM response — strip markdown fences if present
      let cleaned = fullResponse.trim();
      const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        cleaned = jsonMatch[1].trim();
      }

      let parsed: {
        captions?: Record<string, string>;
        params?: { epochs?: number; steps?: number; learningRate?: number; loraRank?: number; loraScale?: number };
        reasoning?: string;
      };
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        logger.warn(`[Characters] AI enhance: failed to parse LLM response, falling back. Raw: ${cleaned.slice(0, 500)}`);
        // Fallback if JSON parsing fails
        const captions: Record<string, string> = {};
        for (const fn of filenames) {
          captions[fn] = `${triggerWord}, ${desc}`;
        }
        const suggestedEpochs = Math.max(5, Math.min(30, Math.round(150 / Math.max(1, photoCount))));
        res.json({
          captions,
          params: { epochs: suggestedEpochs, steps: 9, learningRate: 1e-4, loraRank: 8, loraScale: 0.85 },
          totalSteps: suggestedEpochs * photoCount,
        });
        return;
      }

      // Merge parsed results with safe defaults
      const captions: Record<string, string> = {};
      for (const fn of filenames) {
        const llmCaption = parsed.captions?.[fn];
        captions[fn] = llmCaption && llmCaption.trim() ? llmCaption.trim() : `${triggerWord}, ${desc}`;
      }

      const params = {
        epochs: Math.max(1, Math.min(100, parsed.params?.epochs ?? Math.round(150 / Math.max(1, photoCount)))),
        steps: Math.max(1, Math.min(50, parsed.params?.steps ?? 9)),
        learningRate: Math.max(1e-6, Math.min(0.01, parsed.params?.learningRate ?? 1e-4)),
        loraRank: [4, 8, 16, 32].includes(parsed.params?.loraRank ?? 0) ? parsed.params!.loraRank! : 8,
        loraScale: Math.max(0.1, Math.min(1.5, parsed.params?.loraScale ?? 0.85)),
      };

      const totalSteps = params.epochs * photoCount;

      logger.info(`[Characters] AI enhance for '${character.name}': ${Object.keys(captions).length} captions, ${totalSteps} total steps. ${parsed.reasoning ?? ""}`);

      res.json({ captions, params, totalSteps, reasoning: parsed.reasoning });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Characters] AI enhance failed: ${msg}`);
      res.status(500).json({ error: "AI enhance failed" });
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

    const characterName = characterRepo.getById(characterId)?.name ?? characterId;
    _io?.emit("character:training:start", { characterId, characterName });

    // Start polling for completion
    pollTrainingStatus(characterId, characterName, sidecarUrl, token, result.output_dir ?? null, characterRepo);
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
  characterName: string,
  sidecarUrl: string,
  token: string,
  _outputDir: string | null,
  characterRepo: CharacterRepository,
): void {
  const pollIntervalMs = 15_000; // 15 seconds
  const maxPollTimeMs = 4 * 60 * 60 * 1000; // 4 hours max
  const startTime = Date.now();

  const poll = async () => {
    // Stop polling if training was cancelled
    if (_cancelledTraining.has(characterId)) {
      _cancelledTraining.delete(characterId);
      return;
    }

    if (Date.now() - startTime > maxPollTimeMs) {
      characterRepo.update(characterId, {
        status: "failed",
        errorMessage: "Training timed out after 4 hours",
      });
      _io?.emit("character:training:failed", { characterId, characterName });
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
        _io?.emit("character:training:failed", { characterId, characterName });
        logger.error(`[Characters] Remote training failed for ${characterId}: ${status.error}`);
      } else if (status.lora_path) {
        characterRepo.update(characterId, {
          status: "ready",
          trainedLoraPath: status.lora_path,
          errorMessage: null,
        });
        _io?.emit("character:training:complete", { characterId, characterName });
        logger.info(`[Characters] Remote training complete for ${characterId}: ${status.lora_path}`);
      } else {
        characterRepo.update(characterId, {
          status: "failed",
          errorMessage: "Training completed but no LoRA adapter found in output directory",
        });
        _io?.emit("character:training:failed", { characterId, characterName });
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
