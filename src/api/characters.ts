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
import type { CopilotWrapperService, SdkAttachment } from "../copilot/copilot-wrapper.js";
import type { Server as SocketIOServer } from "socket.io";
import { getUserSelectedModel } from "../config/user-model.js";
import type { ChannelManager } from "../channels/channel-manager.js";

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

// ── Channel manager (injected for Telegram training notifications) ─
let _channelManager: ChannelManager | null = null;
let _fallbackChatId: string | undefined;
export function setCharacterChannelManager(mgr: ChannelManager, fallbackChatId?: string): void {
  _channelManager = mgr;
  _fallbackChatId = fallbackChatId;
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

      // Best-effort: remove training output (LoRA checkpoints + adapter) from the
      // image-gen sidecar (mac mini).  Do not let a sidecar failure block the delete.
      try {
        const sidecarUrl = await getImageGenSidecarUrl();
        const sidecarToken = await getImageGenToken();
        if (sidecarUrl) {
          const cleanupRes = await fetch(`${sidecarUrl}/train-data`, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              ...(sidecarToken ? { Authorization: `Bearer ${sidecarToken}` } : {}),
            },
            body: JSON.stringify({ character_id: req.params.id }),
          });
          const cleanupBody = await cleanupRes.json().catch(() => ({}));
          logger.info(
            `[Characters] Sidecar train-data cleanup for '${character.name}' (${req.params.id}): ${JSON.stringify(cleanupBody)}`
          );
        }
      } catch (cleanupErr) {
        logger.warn(
          `[Characters] Could not clean up sidecar training files for '${character.name}' (${req.params.id}): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
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
      const loraRank = typeof overrides.loraRank === "number" ? overrides.loraRank : 16;
      const numEpochs = typeof overrides.numEpochs === "number" ? overrides.numEpochs : 50;
      const notifyViaTelegram = overrides.notifyViaTelegram === true;
      const telegramChatId = typeof overrides.telegramChatId === "string" ? overrides.telegramChatId : undefined;

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
      startRemoteTraining(character.id, sidecarUrl, trainConfig, photos, characterRepo, notifyViaTelegram, telegramChatId);

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

  // ── GET /:id/checkpoints — List resumable checkpoints on the sidecar ──
  router.get("/:id/checkpoints", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      const sidecarUrl = await getImageGenSidecarUrl();
      if (!sidecarUrl) {
        res.status(503).json({ error: "Image generation sidecar not configured" });
        return;
      }
      const token = await getImageGenToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(
        `${sidecarUrl}/train-checkpoints?character_id=${encodeURIComponent(req.params.id)}`,
        { headers },
      );
      if (!response.ok) {
        const text = await response.text();
        res.status(502).json({ error: `Sidecar error: ${text}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/resume-training — Resume training from a checkpoint ──
  router.post("/:id/resume-training", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      if (character.status === "training") {
        res.status(409).json({ error: "Character is already training" });
        return;
      }

      const { checkpoint_path } = req.body as { checkpoint_path?: string };
      if (!checkpoint_path || typeof checkpoint_path !== "string") {
        res.status(400).json({ error: "checkpoint_path is required" });
        return;
      }

      const sidecarUrl = await getImageGenSidecarUrl();
      if (!sidecarUrl) {
        res.status(503).json({ error: "Image generation sidecar not configured" });
        return;
      }
      const token = await getImageGenToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(`${sidecarUrl}/train-resume`, {
        method: "POST",
        headers,
        body: JSON.stringify({ checkpoint_path }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Sidecar returned ${response.status}: ${text}`);
      }

      const result = await response.json() as { status: string; message: string; output_dir?: string };

      characterRepo.update(character.id, {
        status: "training",
        errorMessage: null,
      });
      _io?.emit("character:training:start", { characterId: character.id, characterName: character.name });

      // Resume polling — will pick up completion just like a fresh training run
      pollTrainingStatus(
        character.id,
        character.name,
        sidecarUrl,
        token,
        result.output_dir ?? null,
        characterRepo,
      );

      logger.info(`[Characters] Resumed training for '${character.name}' (${character.id}) from ${checkpoint_path}`);
      res.json({ ok: true, message: result.message });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/recover-training — Check sidecar for a completed LoRA after a poll timeout ──
  router.post("/:id/recover-training", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) { res.status(404).json({ error: "Character not found" }); return; }

      const sidecarUrl = await getImageGenSidecarUrl();
      if (!sidecarUrl) { res.status(503).json({ error: "Image generation sidecar not configured" }); return; }
      const token = await getImageGenToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const statusRes = await fetch(`${sidecarUrl}/train-status?character_id=${encodeURIComponent(character.id)}`, { headers });
      if (!statusRes.ok) {
        res.status(502).json({ error: `Sidecar returned HTTP ${statusRes.status}` });
        return;
      }

      const status = await statusRes.json() as {
        training: boolean;
        error?: string;
        lora_path?: string;
      };

      if (status.training) {
        // Still training — restart polling so the server captures completion
        characterRepo.update(character.id, { status: "training", errorMessage: null });
        pollTrainingStatus(character.id, character.name, sidecarUrl, token, null, characterRepo);
        res.json({ ok: true, recovered: false, message: "Training is still in progress — polling restarted." });
        return;
      }

      if (status.lora_path) {
        characterRepo.update(character.id, {
          status: "ready",
          trainedLoraPath: status.lora_path,
          errorMessage: null,
        });
        _io?.emit("character:training:complete", { characterId: character.id, characterName: character.name });
        // Clean up training data since we've confirmed the character is ready.
        // The DELETE relocates the adapter to ~/.openzigs/loras/ and returns the new path.
        let finalLoraPath = status.lora_path;
        try {
          const cleanupHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (token) cleanupHeaders["Authorization"] = `Bearer ${token}`;
          const cleanupRes = await fetch(`${sidecarUrl}/train-data`, {
            method: "DELETE",
            headers: cleanupHeaders,
            body: JSON.stringify({ character_id: character.id }),
          });
          if (cleanupRes.ok) {
            const cleanupBody = await cleanupRes.json() as { lora_path?: string };
            if (cleanupBody.lora_path) {
              finalLoraPath = cleanupBody.lora_path;
              characterRepo.update(character.id, { trainedLoraPath: finalLoraPath });
              logger.info(`[Characters] Updated LoRA path for ${character.id}: ${finalLoraPath}`);
            }
          }
        } catch { /* non-critical */ }
        logger.info(`[Characters] Recovered training for '${character.name}' (${character.id}): ${finalLoraPath}`);
        res.json({ ok: true, recovered: true, loraPath: finalLoraPath, message: "Training was already complete — character marked as ready." });
        return;
      }

      res.json({
        ok: false,
        recovered: false,
        message: status.error
          ? `Training failed on sidecar: ${status.error}`
          : "No trained LoRA found on the sidecar. You may need to re-train or resume from a checkpoint.",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/pause-training — Pause active training (SIGSTOP via sidecar) ──
  router.post("/:id/pause-training", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) { res.status(404).json({ error: "Character not found" }); return; }
      if (character.status !== "training") {
        res.status(409).json({ error: "Character is not currently training" });
        return;
      }
      const sidecarUrl = await getImageGenSidecarUrl();
      if (!sidecarUrl) { res.status(503).json({ error: "Image generation sidecar not configured" }); return; }
      const token = await getImageGenToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const response = await fetch(`${sidecarUrl}/train-pause`, { method: "POST", headers });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Sidecar returned ${response.status}: ${text}`);
      }
      const result = await response.json() as { ok: boolean; message: string };
      _io?.emit("character:training:paused", { characterId: character.id });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/unpause-training — Unpause training (SIGCONT via sidecar) ──
  router.post("/:id/unpause-training", async (req, res) => {
    try {
      const character = characterRepo.getById(req.params.id);
      if (!character) { res.status(404).json({ error: "Character not found" }); return; }
      if (character.status !== "training") {
        res.status(409).json({ error: "Character is not currently training" });
        return;
      }
      const sidecarUrl = await getImageGenSidecarUrl();
      if (!sidecarUrl) { res.status(503).json({ error: "Image generation sidecar not configured" }); return; }
      const token = await getImageGenToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const response = await fetch(`${sidecarUrl}/train-unpause`, { method: "POST", headers });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Sidecar returned ${response.status}: ${text}`);
      }
      const result = await response.json() as { ok: boolean; message: string };
      _io?.emit("character:training:resumed", { characterId: character.id });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── POST /:id/ai-enhance — Auto-generate captions via vision (one image per request) ──
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

      // Determine model: body override → user config → copilot default
      const bodyModel = typeof (req.body as Record<string, unknown>)?.model === "string"
        ? (req.body as Record<string, unknown>).model as string
        : undefined;
      const resolvedModel = bodyModel ?? await getUserSelectedModel();

      if (!copilot) {
        // Fallback when copilot is unavailable — use simple varied templates
        const variedSuffixes = [
          `portrait, natural lighting, sharp focus`,
          `close-up, studio lighting, detailed`,
          `full body, outdoor setting, natural environment`,
          `side profile, soft lighting, bokeh background`,
          `3/4 view, golden hour lighting, warm tones`,
          `looking at camera, overcast lighting, high detail`,
          `candid pose, indoor setting, ambient light`,
          `low angle shot, dynamic pose, vibrant colors`,
          `overhead view, clean background, crisp focus`,
          `backlit, dramatic lighting, silhouette detail`,
        ];
        const captions: Record<string, string> = {};
        for (let i = 0; i < filenames.length; i++) {
          const suffix = variedSuffixes[i % variedSuffixes.length];
          captions[filenames[i]] = `${triggerWord}, ${desc}, ${suffix}`;
        }
        res.json({ captions, totalSteps: photoCount * 50 });
        return;
      }

      // Verify which photos are accessible
      const accessiblePhotos: { photoPath: string; filename: string }[] = [];
      for (let i = 0; i < character.referencePhotos.length; i++) {
        const photoPath = character.referencePhotos[i];
        try {
          await fs.access(photoPath);
          accessiblePhotos.push({ photoPath, filename: filenames[i] });
        } catch {
          logger.warn(`[Characters] AI enhance: photo not accessible, skipping: ${photoPath}`);
        }
      }

      if (accessiblePhotos.length === 0) {
        res.status(400).json({ error: "No reference photos are accessible on disk" });
        return;
      }

      const modelLabel = resolvedModel ?? "default";
      logger.info(`[Characters] AI enhance for '${character.name}': analyzing ${accessiblePhotos.length} photos one-by-one with model=${modelLabel}`);

      // Process images one at a time to avoid overwhelming the model
      const captions: Record<string, string> = {};

      for (let i = 0; i < accessiblePhotos.length; i++) {
        const { photoPath, filename } = accessiblePhotos[i];
        const conversationId = `ai-enhance-${character.id}-${Date.now()}-${i}`;

        const attachment: SdkAttachment = { type: "file", path: photoPath, displayName: filename };

        const systemMsg = `You are a vision-capable AI analyzing a reference photo for LoRA training. Describe what you actually see in the attached image to create an accurate training caption.

RULES:
- Examine the attached image carefully and describe the actual visible content.
- The caption MUST start with the exact trigger word "${triggerWord}".
- Describe what you see: the subject, pose, framing, lighting, background, and notable visual details.
- Keep the caption concise: 8-20 words.
- Respond with ONLY the caption text — no JSON, no markdown, no explanation.`;

        const userMsg = `Subject description: "${desc}"
Trigger word: "${triggerWord}"

Please look at the attached image (${filename}) and write a single training caption that accurately describes what you see. Start with "${triggerWord}".`;

        let captionResponse = "";
        try {
          for await (const chunk of copilot.chat(userMsg, {
            conversationId,
            systemMessage: { mode: "replace", content: systemMsg },
            tools: [],
            availableTools: [],
            attachments: [attachment],
            ...(resolvedModel ? { model: resolvedModel } : {}),
          })) {
            captionResponse += chunk;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Characters] AI enhance: vision failed for ${filename}: ${errMsg}`);
        } finally {
          await copilot.destroySession(conversationId).catch(() => {});
        }

        // Clean up the response
        let caption = captionResponse.trim();
        // Remove quotes if wrapped
        if ((caption.startsWith('"') && caption.endsWith('"')) || (caption.startsWith("'") && caption.endsWith("'"))) {
          caption = caption.slice(1, -1).trim();
        }
        captions[filename] = caption || `${triggerWord}, ${desc}`;

        logger.info(`[Characters] AI enhance: ${i + 1}/${accessiblePhotos.length} — ${filename}`);
      }

      logger.info(`[Characters] AI enhance for '${character.name}': ${Object.keys(captions).length} captions generated with model=${modelLabel}`);

      res.json({ captions, totalSteps: photoCount * 50, model: modelLabel });
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

// ── Telegram notification helper for training events ──────────────────────
function sendTrainingTelegramNotification(
  characterId: string,
  characterName: string,
  outcome: "complete" | "failed",
  chatId: string,
  message?: string,
): void {
  const telegram = _channelManager?.getChannel("telegram");
  if (!telegram || !telegram.isConnected()) return;
  const text = outcome === "complete"
    ? `✅ *LoRA training complete* for character *${characterName}*. Ready to use!`
    : `❌ *LoRA training failed* for character *${characterName}*${message ? `\n${message}` : ""}. Please check the logs.`;
  telegram.sendMessage(chatId, { text, markdown: true }).catch((err: unknown) => {
    logger.warn(`[Characters] Failed to send training Telegram notification for ${characterId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ── Remote Training Manager ─────────────────────────────────

async function startRemoteTraining(
  characterId: string,
  sidecarUrl: string,
  trainConfig: Record<string, unknown>,
  photos: Array<{ image_base64: string; filename: string; prompt: string }>,
  characterRepo: CharacterRepository,
  notifyViaTelegram = false,
  telegramChatId?: string,
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
    pollTrainingStatus(characterId, characterName, sidecarUrl, token, result.output_dir ?? null, characterRepo, notifyViaTelegram, telegramChatId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    characterRepo.update(characterId, {
      status: "failed",
      errorMessage: `Failed to start remote training: ${msg}`,
    });
    logger.error(`[Characters] Remote training request failed for ${characterId}: ${msg}`);
  }
}

async function getTrainingTimeoutMs(): Promise<number> {
  const DEFAULT_HOURS = 12; // minimum for realistic LoRA jobs
  try {
    const configPath = process.env.OPENZIGS_CONFIG_PATH
      ?? path.join(os.homedir(), ".openzigs", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ig = parsed.imageGen as Record<string, unknown> | undefined;
    let hours = typeof ig?.trainingTimeoutHours === "number" ? ig.trainingTimeoutHours : DEFAULT_HOURS;
    // never allow less than 12h to avoid premature timeouts from impatient clients
    if (hours < DEFAULT_HOURS) hours = DEFAULT_HOURS;
    return hours * 60 * 60 * 1000;
  } catch {
    return DEFAULT_HOURS * 60 * 60 * 1000;
  }
}

function pollTrainingStatus(
  characterId: string,
  characterName: string,
  sidecarUrl: string,
  token: string,
  _outputDir: string | null,
  characterRepo: CharacterRepository,
  notifyViaTelegram = false,
  telegramChatId?: string,
): void {
  const pollIntervalMs = 15_000; // 15 seconds
  const startTime = Date.now();

  const maybeNotify = (outcome: "complete" | "failed", message?: string) => {
    if (!notifyViaTelegram) return;
    const chatId = telegramChatId ?? _fallbackChatId;
    if (chatId) sendTrainingTelegramNotification(characterId, characterName, outcome, chatId, message);
  };

  const poll = async () => {
    // Stop polling if training was cancelled
    if (_cancelledTraining.has(characterId)) {
      _cancelledTraining.delete(characterId);
      return;
    }

    const maxPollTimeMs = await getTrainingTimeoutMs();
    const elapsed = Date.now() - startTime;
    if (elapsed > maxPollTimeMs) {
      const hours = Math.round(maxPollTimeMs / 3_600_000);
      // On timeout, check if the sidecar has a usable partial checkpoint
      try {
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const statusRes = await fetch(`${sidecarUrl}/train-status?character_id=${encodeURIComponent(characterId)}`, { headers });
        if (statusRes.ok) {
          const status = await statusRes.json() as {
            training: boolean;
            lora_path?: string;
            checkpoint_count?: number;
          };
          if (status.lora_path) {
            // Partial checkpoint is usable — mark as ready with a note
            characterRepo.update(characterId, {
              status: "ready",
              trainedLoraPath: status.lora_path,
              errorMessage: `Training timed out after ${hours}h but a partial checkpoint was saved and is usable. Results may improve with more training.`,
            });
            _io?.emit("character:training:complete", { characterId, characterName, partial: true });
            maybeNotify("complete");
            logger.warn(`[Characters] Training timed out for ${characterId} but partial checkpoint is usable: ${status.lora_path}`);
            return;
          }
        }
      } catch {
        // Could not reach sidecar — fall through to standard timeout error
      }
      characterRepo.update(characterId, {
        status: "failed",
        errorMessage: `Training timed out after ${hours} hours. The sidecar may still be training — check its logs. You can increase the timeout in config (imageGen.trainingTimeoutHours).`,
      });
      _io?.emit("character:training:failed", { characterId, characterName });
      maybeNotify("failed", `Timed out after ${hours}h`);
      logger.error(`[Characters] Training timed out for ${characterId}`);
      return;
    }

    try {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(`${sidecarUrl}/train-status?character_id=${encodeURIComponent(characterId)}`, { headers });
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
        maybeNotify("failed", status.error);
        logger.error(`[Characters] Remote training failed for ${characterId}: ${status.error}`);
      } else if (status.lora_path) {
        characterRepo.update(characterId, {
          status: "ready",
          trainedLoraPath: status.lora_path,
          errorMessage: null,
        });
        _io?.emit("character:training:complete", { characterId, characterName });
        maybeNotify("complete");
        logger.info(`[Characters] Remote training complete for ${characterId}: ${status.lora_path}`);

        // Clean up training data on the sidecar now that the character is confirmed ready.
        // The DELETE relocates the adapter to ~/.openzigs/loras/ and returns the new path.
        try {
          const cleanupHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (token) cleanupHeaders["Authorization"] = `Bearer ${token}`;
          const cleanupRes = await fetch(`${sidecarUrl}/train-data`, {
            method: "DELETE",
            headers: cleanupHeaders,
            body: JSON.stringify({ character_id: characterId }),
          });
          if (cleanupRes.ok) {
            const cleanupBody = await cleanupRes.json() as { lora_path?: string };
            if (cleanupBody.lora_path) {
              characterRepo.update(characterId, { trainedLoraPath: cleanupBody.lora_path });
              logger.info(`[Characters] Updated LoRA path for ${characterId}: ${cleanupBody.lora_path}`);
            }
          }
        } catch {
          // Non-critical — data will be cleaned up eventually
        }
      } else {
        characterRepo.update(characterId, {
          status: "failed",
          errorMessage: "Training completed but no LoRA adapter found in output directory",
        });
        _io?.emit("character:training:failed", { characterId, characterName });
        maybeNotify("failed", "No LoRA adapter found");
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

/**
 * On server start, resume polling for any characters stuck in "training" status.
 * This handles the case where the openzigs server restarted while the sidecar
 * was still training — re-poll so we capture completion or partial results.
 */
export async function resumeStaleTrainingPolls(
  characterRepo: CharacterRepository,
): Promise<void> {
  const stale = characterRepo.getByStatus("training");
  if (stale.length === 0) return;

  const sidecarUrl = await getImageGenSidecarUrl();
  if (!sidecarUrl) {
    logger.warn(`[Characters] ${stale.length} character(s) stuck in training but no sidecar configured — marking as failed`);
    for (const c of stale) {
      characterRepo.update(c.id, {
        status: "failed",
        errorMessage: "Server restarted during training and sidecar is not configured. Re-train when ready.",
      });
    }
    return;
  }

  const token = await getImageGenToken();
  for (const character of stale) {
    logger.info(`[Characters] Resuming training poll for '${character.name}' (${character.id})`);
    pollTrainingStatus(character.id, character.name, sidecarUrl, token, null, characterRepo);
  }
}
