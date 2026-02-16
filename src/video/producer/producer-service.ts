/**
 * Director Mode — Producer Service
 * Issue #239: Single-Shot LLM orchestration for video production.
 * Takes ingested ContextPayload → single LLM call → DirectorManifest.
 */

import fs from "node:fs/promises";
import { logger } from "../../logging/logger.js";
import { validateManifest } from "../manifest/manifest-validator.js";
import { TEMPLATE_IDS } from "../templates/template-registry.js";
import { formatContextForPrompt } from "../ingestion/context-assembler.js";
import { buildHighlightReelPrompt, buildScriptDrivenPrompt, buildUserPrompt } from "./prompts.js";
import { getAudioDuration } from "../ingestion/audio-extractor.js";
import type { DirectorManifest } from "../manifest/manifest-types.js";
import type { ContextPayload } from "../ingestion/types.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";

/** Metadata extracted from the music track via ffprobe. */
export interface MusicMetadata {
  path: string;
  durationSec: number;
  codec?: string;
}

export interface ProducerInput {
  mode: "highlight" | "script";
  contextPayload: ContextPayload;
  /** Path to script.txt (Mode B only) */
  scriptPath?: string;
  /** Path to background music track (optional) */
  musicTrackPath?: string;
  /** Preferred template ID (optional — LLM will choose if omitted) */
  preferredTemplate?: string;
  /** Pre-generated voiceover path (skip TTS if provided) */
  voiceoverPath?: string;
  /** Model override for the LLM call (e.g. "gpt-4.1", "claude-sonnet-4") */
  model?: string;
}

export interface ProducerResult {
  manifest: DirectorManifest;
  tokensUsed: number;
}

export class ProducerService {
  constructor(
    private readonly copilot: CopilotWrapper,
    private readonly voiceService?: VoiceService,
  ) {}

  /**
   * Produce a DirectorManifest from the ingested context.
   * Mode A: Highlight Reel — direct context → manifest
   * Mode B: Script-Driven — TTS voiceover → aligned manifest
   */
  async produce(input: ProducerInput): Promise<ProducerResult> {
    let voiceoverPath = input.voiceoverPath;
    let voiceoverDuration = 0;
    let scriptText: string | undefined;

    // Mode B pre-step: Generate voiceover from script
    if (input.mode === "script") {
      if (!input.scriptPath && !voiceoverPath) {
        throw new Error("Script-driven mode requires either a scriptPath or voiceoverPath");
      }

      if (input.scriptPath) {
        scriptText = await fs.readFile(input.scriptPath, "utf-8");
      }

      if (!voiceoverPath && scriptText && this.voiceService) {
        voiceoverPath = await this.generateVoiceover(scriptText);
      }

      if (voiceoverPath) {
        voiceoverDuration = await getAudioDuration(voiceoverPath);
      }
    }

    // Probe music file for metadata (duration, codec) so the LLM can plan around it
    let musicMetadata: MusicMetadata | undefined;
    if (input.musicTrackPath) {
      musicMetadata = await this.probeMusicTrack(input.musicTrackPath);
    }

    // Build the system prompt based on mode
    const systemPrompt = input.mode === "highlight"
      ? buildHighlightReelPrompt(TEMPLATE_IDS, input.preferredTemplate)
      : buildScriptDrivenPrompt(voiceoverDuration, TEMPLATE_IDS, input.preferredTemplate);

    // Build the user prompt with the full context
    const contextText = formatContextForPrompt(input.contextPayload);
    const userPrompt = buildUserPrompt(contextText, {
      mode: input.mode,
      scriptText,
      voiceoverPath,
      musicTrackPath: input.musicTrackPath,
      musicMetadata,
    });

    logger.info(`[Producer] Sending single-shot LLM request (mode: ${input.mode})`);

    // SINGLE-SHOT: One LLM call with full context
    const chunks: string[] = [];
    const stream = this.copilot.chat(
      `${systemPrompt}\n\n${userPrompt}`,
      {
        // No tools — we just want the JSON manifest output
        tools: [],
        // Allow model override for Director-specific LLM selection
        ...(input.model ? { model: input.model } : {}),
      },
    );

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const responseText = chunks.join("");

    // Parse the JSON manifest from the response
    const manifest = this.parseManifestFromResponse(responseText);

    // Inject voiceover into audioLayer if generated
    if (input.mode === "script" && voiceoverPath && manifest.audioLayer) {
      manifest.audioLayer.voiceover = {
        source: voiceoverPath,
        volume: 1.0,
        startAtFrame: 0,
      };
    }

    // Post-process: ensure LLM's music track path matches the actual input
    // (LLMs sometimes hallucinate or rename the path)
    if (input.musicTrackPath && manifest.audioLayer) {
      if (!manifest.audioLayer.music) {
        // LLM forgot to include music — inject it with sensible defaults
        logger.warn("[Producer] LLM omitted music from manifest; injecting provided track");
        manifest.audioLayer.music = {
          track: input.musicTrackPath,
          volume: 0.3,
          ducking: !!voiceoverPath,
          fadeInFrames: 30,
          fadeOutFrames: 60,
          loop: true,
        };
      } else if (manifest.audioLayer.music.track !== input.musicTrackPath) {
        logger.info(`[Producer] Correcting music path: "${manifest.audioLayer.music.track}" → "${input.musicTrackPath}"`);
        manifest.audioLayer.music.track = input.musicTrackPath;
      }
    }

    // Validate the manifest
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      logger.warn(`[Producer] LLM produced invalid manifest: ${validation.errors.join("; ")}`);
      throw new Error(`LLM produced invalid manifest: ${validation.errors.join("; ")}`);
    }

    if (validation.warnings.length > 0) {
      logger.info(`[Producer] Manifest warnings: ${validation.warnings.join("; ")}`);
    }

    // Approximate token usage from response length
    const tokensUsed = Math.ceil((systemPrompt.length + userPrompt.length + responseText.length) / 4);

    logger.info(`[Producer] Manifest generated — "${manifest.projectTitle}" (${manifest.timeline.length} entries)`);

    return { manifest, tokensUsed };
  }

  /**
   * Probe a music track file for metadata using ffprobe.
   */
  private async probeMusicTrack(musicPath: string): Promise<MusicMetadata> {
    try {
      const ffmpeg = (await import("fluent-ffmpeg")).default;
      return new Promise<MusicMetadata>((resolve) => {
        ffmpeg.ffprobe(musicPath, (err: Error | null, metadata: {
          format?: { duration?: number };
          streams?: Array<{ codec_name?: string; codec_type?: string }>;
        }) => {
          if (err) {
            logger.warn(`[Producer] Failed to probe music track: ${err.message}`);
            resolve({ path: musicPath, durationSec: 0 });
            return;
          }
          const durationSec = metadata?.format?.duration ?? 0;
          const audioStream = metadata?.streams?.find((s) => s.codec_type === "audio");
          const codec = audioStream?.codec_name;
          logger.info(`[Producer] Music track: ${musicPath} (${durationSec.toFixed(1)}s, codec: ${codec ?? "unknown"})`);
          resolve({ path: musicPath, durationSec, codec });
        });
      });
    } catch {
      logger.warn("[Producer] ffprobe not available for music analysis");
      return { path: musicPath, durationSec: 0 };
    }
  }

  /**
   * Generate a voiceover from script text using the VoiceService.
   * Returns the path to the generated audio file.
   */
  private async generateVoiceover(scriptText: string): Promise<string> {
    if (!this.voiceService || !this.voiceService.isReady()) {
      throw new Error("VoiceService not available for voiceover generation");
    }

    const result = await this.voiceService.synthesize(scriptText);

    // Write the audio to a temp file
    const os = await import("node:os");
    const path = await import("node:path");
    const { nanoid } = await import("nanoid");

    const voiceoverPath = path.join(os.tmpdir(), `openzigs-voiceover-${nanoid(8)}.mp3`);
    await fs.writeFile(voiceoverPath, result.audio);

    logger.info(`[Producer] Generated voiceover: ${voiceoverPath} (${result.audio.length} bytes)`);
    return voiceoverPath;
  }

  /**
   * Extract JSON from the LLM response, handling potential markdown wrapping.
   */
  private parseManifestFromResponse(responseText: string): DirectorManifest {
    let jsonText = responseText.trim();

    // Strip markdown code block wrappers if present
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.slice(7);
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith("```")) {
      jsonText = jsonText.slice(0, -3);
    }
    jsonText = jsonText.trim();

    try {
      return JSON.parse(jsonText) as DirectorManifest;
    } catch {
      // Try to find the JSON object within the response
      const jsonStart = responseText.indexOf("{");
      const jsonEnd = responseText.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const extracted = responseText.slice(jsonStart, jsonEnd + 1);
        try {
          return JSON.parse(extracted) as DirectorManifest;
        } catch {
          throw new Error("Failed to parse LLM response as JSON manifest");
        }
      }
      throw new Error("No JSON object found in LLM response");
    }
  }
}
