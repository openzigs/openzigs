/**
 * Voice API routes — TTS synthesis + STT transcription + config + cache management
 * Issue #229: Backend Voice API
 * Issue #260/#264: Extended with local sidecar support (transcription, health, voices, unload)
 */

import { Router } from "express";
import multer from "multer";
import type { VoiceService } from "../voice/index.js";
import { AVAILABLE_VOICES, AVAILABLE_LOCAL_VOICES } from "../voice/index.js";
import { logger } from "../logging/logger.js";

interface VoiceRouterDeps {
  voiceService: VoiceService;
}

// Multer for audio upload (transcription endpoint) — 25MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export function createVoiceRouter({ voiceService }: VoiceRouterDeps): Router {
  const router = Router();

  /**
   * POST /api/voice/speak
   * Synthesize text to audio.
   * Google provider: returns audio/mpeg (MP3).
   * Local provider: returns audio/wav (WAV).
   * Request body: { text: string; voice?: string }
   */
  router.post("/speak", async (req, res) => {
    try {
      if (!voiceService.isReady()) {
        res.status(503).json({
          error: "Voice service not available. Check provider configuration.",
        });
        return;
      }

      const { text, voice } = req.body as { text?: string; voice?: string };

      if (!text || typeof text !== "string" || text.trim().length === 0) {
        res
          .status(400)
          .json({
            error: "Request body must contain a non-empty 'text' field.",
          });
        return;
      }

      const config = voiceService.getConfig();
      if (text.length > config.maxTextLength) {
        res.status(400).json({
          error: `Text exceeds maximum length of ${config.maxTextLength} characters.`,
        });
        return;
      }

      const result = await voiceService.synthesize(text, voice);

      const contentType = result.contentType ?? "audio/mpeg";
      res.set({
        "Content-Type": contentType,
        "Content-Length": String(result.audio.length),
        "X-Voice-Cached": String(result.cached),
        "X-Voice-Duration-Ms": String(result.durationMs),
        "X-Voice-Provider": voiceService.getProvider(),
        "Cache-Control": "no-store",
      });
      res.send(result.audio);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Voice synthesis error: ${details}`);

      if (details.includes("quota") || details.includes("RESOURCE_EXHAUSTED")) {
        res
          .status(429)
          .json({ error: "TTS API quota exceeded. Try again later." });
      } else if (
        details.includes("credentials") ||
        details.includes("UNAUTHENTICATED")
      ) {
        res.status(503).json({ error: "TTS credentials invalid or missing." });
      } else if (details.includes("sidecar") || details.includes("fetch")) {
        res
          .status(502)
          .json({ error: `Audio sidecar unreachable: ${details}` });
      } else {
        res.status(502).json({ error: `TTS synthesis failed: ${details}` });
      }
    }
  });

  /**
   * POST /api/voice/transcribe
   * Transcribe audio file to text (local sidecar only).
   * Accepts multipart audio upload (wav, mp3, webm, m4a, ogg, flac).
   */
  router.post("/transcribe", upload.single("audio"), async (req, res) => {
    try {
      if (!voiceService.isReady()) {
        res.status(503).json({ error: "Voice service not available." });
        return;
      }

      if (voiceService.getProvider() !== "local") {
        res.status(400).json({
          error:
            "Transcription is only available with the local audio sidecar provider.",
        });
        return;
      }

      const file = req.file;
      if (!file) {
        res
          .status(400)
          .json({
            error:
              "No audio file provided. Use multipart form with 'audio' field.",
          });
        return;
      }

      const result = await voiceService.transcribe(
        file.buffer,
        file.originalname,
      );
      res.json(result);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Voice transcription error: ${details}`);
      res.status(502).json({ error: `Transcription failed: ${details}` });
    }
  });

  /**
   * GET /api/voice/config
   * Returns the current voice configuration and available voices.
   */
  router.get("/config", (_req, res) => {
    const config = voiceService.getConfig();
    const provider = voiceService.getProvider();
    const voices =
      provider === "local" ? AVAILABLE_LOCAL_VOICES : AVAILABLE_VOICES;
    res.json({
      enabled: config.enabled,
      provider,
      voiceName: config.voiceName,
      speakingRate: config.speakingRate,
      pitch: config.pitch,
      maxCacheSizeMb: config.maxCacheSizeMb,
      maxTextLength: config.maxTextLength,
      sidecarUrl:
        provider === "local" ? voiceService.getSidecarUrl() : undefined,
      voices,
      ready: voiceService.isReady(),
    });
  });

  /**
   * GET /api/voice/voices
   * List available voices for the current provider.
   * For local provider, fetches live from the sidecar.
   */
  router.get("/voices", async (_req, res) => {
    try {
      if (voiceService.getProvider() === "local") {
        const localVoices = await voiceService.getLocalVoices();
        if (localVoices.length > 0) {
          res.json({ provider: "local", voices: localVoices });
          return;
        }
        // Fallback to static list
        res.json({ provider: "local", voices: AVAILABLE_LOCAL_VOICES });
      } else {
        res.json({ provider: "google", voices: AVAILABLE_VOICES });
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Voice list error: ${details}`);
      res.status(500).json({ error: details });
    }
  });

  /**
   * GET /api/voice/health
   * Returns voice service health including sidecar status (if local).
   */
  router.get("/health", async (_req, res) => {
    try {
      const provider = voiceService.getProvider();
      const ready = voiceService.isReady();

      if (provider === "local") {
        try {
          const sidecarHealth = await voiceService.getSidecarHealth();
          res.json({
            provider,
            ready,
            sidecar: sidecarHealth,
          });
        } catch (error) {
          const details =
            error instanceof Error ? error.message : String(error);
          res.json({
            provider,
            ready,
            sidecar: { status: "unreachable", error: details },
          });
        }
      } else {
        res.json({
          provider,
          ready,
          sidecar: null,
        });
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: details });
    }
  });

  /**
   * POST /api/voice/preview
   * Quick TTS preview — same as /speak but with a short text limit.
   * Useful for voice selection UI.
   */
  router.post("/preview", async (req, res) => {
    try {
      if (!voiceService.isReady()) {
        res.status(503).json({ error: "Voice service not available." });
        return;
      }

      const { text, voice, voiceName } = req.body as {
        text?: string;
        voice?: string;
        voiceName?: string;
      };
      const resolvedVoice = voice ?? voiceName;
      const previewText = text?.trim() || "Hello! This is a voice preview.";

      if (previewText.length > 200) {
        res
          .status(400)
          .json({ error: "Preview text must be 200 characters or less." });
        return;
      }

      const result = await voiceService.synthesize(previewText, resolvedVoice);
      const contentType = result.contentType ?? "audio/mpeg";

      res.set({
        "Content-Type": contentType,
        "Content-Length": String(result.audio.length),
        "X-Voice-Cached": String(result.cached),
        "X-Voice-Provider": voiceService.getProvider(),
        "Cache-Control": "no-store",
      });
      res.send(result.audio);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Voice preview error: ${details}`);
      res.status(502).json({ error: `Preview failed: ${details}` });
    }
  });

  /**
   * POST /api/voice/unload
   * Unload sidecar models to free RAM (local provider only).
   * Query parameter: model = "tts" | "stt" | "all"
   */
  router.post("/unload", async (req, res) => {
    try {
      if (voiceService.getProvider() !== "local") {
        res
          .status(400)
          .json({
            error: "Unload is only available with the local audio sidecar.",
          });
        return;
      }

      const model = (req.query.model as string) ?? "all";
      if (!["tts", "stt", "all"].includes(model)) {
        res
          .status(400)
          .json({ error: "model must be 'tts', 'stt', or 'all'." });
        return;
      }

      const result = await voiceService.unloadSidecarModels(
        model as "tts" | "stt" | "all",
      );
      res.json({ success: true, ...result });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Voice unload error: ${details}`);
      res.status(502).json({ error: `Unload failed: ${details}` });
    }
  });

  /**
   * GET /api/voice/cache
   * Returns cache statistics.
   */
  router.get("/cache", async (_req, res) => {
    try {
      const stats = await voiceService.getCacheStats();
      res.json(stats);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: details });
    }
  });

  /**
   * DELETE /api/voice/cache
   * Clears the voice cache.
   */
  router.delete("/cache", async (_req, res) => {
    try {
      await voiceService.clearCache();
      res.json({ success: true });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: details });
    }
  });

  return router;
}
