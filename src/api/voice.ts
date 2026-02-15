/**
 * Voice API routes — POST /api/voice/speak + GET /api/voice/config + cache management
 * Issue #229: Backend Voice API
 */

import { Router } from "express";
import type { VoiceService } from "../voice/index.js";
import { AVAILABLE_VOICES } from "../voice/index.js";
import { logger } from "../logging/logger.js";

interface VoiceRouterDeps {
  voiceService: VoiceService;
}

export function createVoiceRouter({ voiceService }: VoiceRouterDeps): Router {
  const router = Router();

  /**
   * POST /api/voice/speak
   * Synthesize text to MP3 audio.
   * Request body: { text: string; voice?: string }
   * Response: MP3 audio stream
   */
  router.post("/speak", async (req, res) => {
    try {
      if (!voiceService.isReady()) {
        res.status(503).json({
          error: "Voice service not available. Check GOOGLE_APPLICATION_CREDENTIALS.",
        });
        return;
      }

      const { text, voice } = req.body as { text?: string; voice?: string };

      if (!text || typeof text !== "string" || text.trim().length === 0) {
        res.status(400).json({ error: "Request body must contain a non-empty 'text' field." });
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

      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": String(result.audio.length),
        "X-Voice-Cached": String(result.cached),
        "X-Voice-Duration-Ms": String(result.durationMs),
        "Cache-Control": "no-store",
      });
      res.send(result.audio);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Voice synthesis error: ${details}`);

      // Map common errors to appropriate HTTP status codes
      if (details.includes("quota") || details.includes("RESOURCE_EXHAUSTED")) {
        res.status(429).json({ error: "TTS API quota exceeded. Try again later." });
      } else if (details.includes("credentials") || details.includes("UNAUTHENTICATED")) {
        res.status(503).json({ error: "TTS credentials invalid or missing." });
      } else {
        res.status(502).json({ error: `TTS synthesis failed: ${details}` });
      }
    }
  });

  /**
   * GET /api/voice/config
   * Returns the current voice configuration and available voices.
   */
  router.get("/config", (_req, res) => {
    const config = voiceService.getConfig();
    res.json({
      enabled: config.enabled,
      provider: config.provider,
      voiceName: config.voiceName,
      speakingRate: config.speakingRate,
      pitch: config.pitch,
      maxCacheSizeMb: config.maxCacheSizeMb,
      voices: AVAILABLE_VOICES,
      ready: voiceService.isReady(),
    });
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
