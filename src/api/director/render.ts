/**
 * Render / production-pipeline routes for Director Mode.
 *
 * Owns the produce pipeline (ingestion → LLM → manifest → render queue),
 * render-job lifecycle, and rendering of derived deliverables (shorts).
 * Extracted from `director.ts` as part of epic #1113 (sub-issue #1164).
 */
import { Router } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logger } from "../../logging/logger.js";
import { getDatabase } from "../../productivity/database.js";
import { getUserSelectedModel } from "../../config/user-model.js";
import type { DirectorContext, ProduceJob } from "./context.js";

export function registerRenderRoutes(
  router: Router,
  ctx: DirectorContext,
): void {
  /**
   * POST /produce — trigger the single-shot production pipeline.
   * Returns 202 immediately with a `produceJobId`; the pipeline runs in the
   * background.  Poll `GET /produce/:id` for status and result.
   *
   * Body (highlight/script): { clips: string[], mode: "highlight" | "script", scriptPath?, musicTrackPath?, template?, model?, enableVisionAnalysis? }
   * Body (presentation):     { mode: "presentation", inputFile: string, sourceType?: "text"|"markdown", topic?: string, musicTrackPath?, template?, model?, imageProvider?, imageModel?, slideStyle?, assetsOnlyMode? }
   */
  router.post("/produce", async (req, res) => {
    try {
      const {
        clips,
        mode,
        scriptPath,
        musicTrackPath,
        template,
        model,
        enableVisionAnalysis,
        inputFile,
        sourceType,
        topic,
        imageProvider,
        imageModel,
        slideStyle,
        assetsOnlyMode,
        quizEnabled,
        visualAssets,
        brandVoiceId,
        imageClipDurationSeconds,
        heroReelOverview,
        defaultClipDuration,
        heroReelImages,
        inspirationContext,
      } = req.body as {
        clips?: string[];
        mode: "highlight" | "script" | "presentation" | "hero-reel";
        scriptPath?: string;
        musicTrackPath?: string;
        template?: string;
        model?: string;
        enableVisionAnalysis?: boolean;
        inputFile?: string;
        sourceType?: "text" | "markdown";
        topic?: string;
        imageProvider?: "cloud" | "local" | "auto";
        imageModel?: "flux" | "flux-schnell" | "flux-dev" | "sdxl-base";
        slideStyle?: boolean;
        assetsOnlyMode?: boolean;
        quizEnabled?: boolean;
        brandVoiceId?: string;
        imageClipDurationSeconds?: number;
        heroReelOverview?: string;
        defaultClipDuration?: number;
        heroReelImages?: Array<{ path: string; description: string }>;
        inspirationContext?: string;
        visualAssets?: Array<{
          path: string;
          description: string;
          type: "image" | "video";
          placement?: {
            startTimeSec: number;
            endTimeSec: number;
            position: string;
            scale: number;
          } | null;
        }>;
      };

      if (
        !mode ||
        !["highlight", "script", "presentation", "hero-reel"].includes(mode)
      ) {
        res.status(400).json({
          error:
            "mode must be 'highlight', 'script', 'presentation', or 'hero-reel'",
        });
        return;
      }

      // Validate mode-specific required fields before creating the job
      if (mode === "presentation" && !inputFile) {
        res
          .status(400)
          .json({ error: "'inputFile' is required for presentation mode" });
        return;
      }
      if (inputFile && (inputFile.includes("\0") || inputFile.includes(".."))) {
        res.status(400).json({ error: "Invalid inputFile path" });
        return;
      }
      if (
        scriptPath &&
        (scriptPath.includes("\0") || scriptPath.includes(".."))
      ) {
        res.status(400).json({ error: "Invalid scriptPath" });
        return;
      }
      if (
        musicTrackPath &&
        (musicTrackPath.includes("\0") || musicTrackPath.includes(".."))
      ) {
        res.status(400).json({ error: "Invalid musicTrackPath" });
        return;
      }
      if (mode === "hero-reel" && !heroReelOverview?.trim()) {
        res
          .status(400)
          .json({ error: "'heroReelOverview' is required for hero-reel mode" });
        return;
      }
      if (
        (mode === "highlight" || mode === "script") &&
        (!clips || !Array.isArray(clips) || clips.length === 0)
      ) {
        res
          .status(400)
          .json({ error: "clips array is required and must not be empty" });
        return;
      }

      // Create produce job and return 202 immediately — pipeline runs in background.
      // This matches the gallery's async pattern: submit → poll for result.
      const produceJobId = nanoid();
      const produceAbort = new AbortController();
      const job: ProduceJob = {
        id: produceJobId,
        status: "running",
        startedAt: Date.now(),
        abort: produceAbort,
      };
      ctx.produceJobs.set(produceJobId, job);

      // Evict old completed/failed jobs (keep last 20)
      const allJobs = [...ctx.produceJobs.values()];
      const finished = allJobs
        .filter((j) => j.status !== "running")
        .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      while (finished.length > 20) {
        const old = finished.shift()!;
        ctx.produceJobs.delete(old.id);
      }

      res.status(202).json({ produceJobId });
      logger.info(
        `[Director API] Produce job ${produceJobId} accepted (mode=${mode}) — running in background`,
      );

      /** Emit a produce activity event via Socket.IO (if available). */
      const emitActivity = (
        phase: string,
        detail?: string,
        extra?: Record<string, unknown>,
      ) => {
        if (!ctx.io()) return;
        ctx.io()!.emit("produce:progress", {
          id: produceJobId,
          mode,
          phase,
          detail,
          timestamp: Date.now(),
          ...extra,
        });
      };

      emitActivity("started", `${mode} pipeline initiated`);

      // ── Background pipeline ────────────────────────────────
      // Everything below runs after the HTTP response has been sent.
      // Errors are captured into the job object, not thrown to Express.
      (async () => {
        /** Throw if the pipeline was cancelled. Call before each major stage. */
        const checkAborted = () => {
          if (produceAbort.signal.aborted) throw new Error("Cancelled by user");
        };

        try {
          // ── Presentation mode: document → storyboard → images → TTS → manifest ──
          if (mode === "presentation") {
            const startTime = Date.now();

            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const os = await import("node:os");
            const { StoryboardEngine } =
              await import("../../video/generators/storyboard-engine.js");
            const { ImageGenService } =
              await import("../../video/generators/image-gen-service.js");
            const { nanoid } = await import("nanoid");

            // Step A: Ingest the text document
            let rawText: string;
            try {
              rawText = await fs.readFile(inputFile!, "utf-8");
            } catch (readErr) {
              const readMsg =
                readErr instanceof Error ? readErr.message : String(readErr);
              throw new Error(`Failed to read input file: ${readMsg}`);
            }

            if (sourceType === "markdown" || inputFile!.endsWith(".md")) {
              rawText = rawText.replace(
                /```[\s\S]*?```/g,
                "[code block removed]",
              );
            }

            logger.info(
              `[Director API] Presentation mode: read ${rawText.length} chars from ${inputFile}`,
            );

            // Step B: Generate storyboard via LLM
            checkAborted();
            emitActivity("storyboard", "Generating storyboard from document");
            const storyboardEngine = new StoryboardEngine(ctx.copilot);
            const storyboardOptions: import("../../video/generators/storyboard-engine.js").StoryboardOptions =
              {};
            if (topic) {
              storyboardOptions.styleHint = topic;
            }
            const resolvedModel =
              model || ctx.runtimeConfig.defaultModel || undefined;
            if (resolvedModel) {
              storyboardOptions.model = resolvedModel;
            }
            // Pass visual asset descriptions so the LLM can weave them into narration
            if (visualAssets && visualAssets.length > 0) {
              storyboardOptions.visualAssets = visualAssets
                .filter((a: { description?: string }) => a.description?.trim())
                .map((a: { description: string; type?: string }) => ({
                  description: a.description,
                  type: (a.type === "video" ? "video" : "image") as
                    | "image"
                    | "video",
                }));
            }
            if (slideStyle) {
              storyboardOptions.slideStyle = true;
            }
            if (assetsOnlyMode && visualAssets && visualAssets.length > 0) {
              storyboardOptions.assetsOnlyMode = true;
            }
            if (
              imageClipDurationSeconds &&
              imageClipDurationSeconds >= 1 &&
              imageClipDurationSeconds <= 10
            ) {
              storyboardOptions.imageClipDurationSeconds =
                imageClipDurationSeconds;
            }
            // Inject brand voice (specific ID or active default) if available
            if (ctx.brandVoiceService) {
              const voiceBlock =
                ctx.brandVoiceService.getVoicePromptBlockById(brandVoiceId);
              if (voiceBlock) storyboardOptions.brandVoiceBlock = voiceBlock;
            }
            const storyboard = await storyboardEngine.generate(
              rawText,
              storyboardOptions,
            );

            logger.info(
              `[Director API] Storyboard generated: "${storyboard.title}" with ${storyboard.scenes.length} scenes`,
            );
            checkAborted();
            emitActivity(
              "images",
              `Generating assets for ${storyboard.scenes.length} scenes`,
            );

            // Step C: Generate images for each scene
            // Generate at ~model-native resolution (NOT output resolution).
            // Diffusion models (SDXL Turbo, Flux, etc.) are trained on specific
            // resolutions; requesting 1920x1080 produces degenerate outputs where
            // the model can't differentiate prompts. The Remotion KenBurns component
            // uses object-fit:cover to scale any source image to fill the frame.
            //
            // Images are stored in ~/.openzigs/director/images/ (persistent) rather
            // than /tmp/ — macOS aggressively purges /tmp/ which caused images to
            // vanish between the produce and render steps.
            const imageOutputDir = path.join(
              os.homedir(),
              ".openzigs",
              "director",
              "images",
            );
            const imageGenUserConfig =
              await ImageGenService.loadUserImageGenConfig();
            const imageService = new ImageGenService({
              outputDir: imageOutputDir,
              ...imageGenUserConfig,
            });
            await imageService.initialize();

            const resolvedImageProvider = imageProvider ?? "auto";
            logger.info(
              `[Director API] Image provider: ${resolvedImageProvider}${imageModel ? `, model: ${imageModel}` : ""}`,
            );

            // Assets-only mode: middle scenes use uploaded assets; only intro (index 0) and
            // outro (last scene) are AI-generated.
            const isAssetsOnlyMode =
              !!assetsOnlyMode && !!visualAssets && visualAssets.length > 0;
            const lastSceneIndex = storyboard.scenes.length - 1;

            // Fixed 16:9 video frame resolution — do not query sidecar (its native training
            // resolution overrides this with e.g. 1024x1024 for Flux, costing 3-5x more time).
            const imageWidth = 768;
            const imageHeight = 432;
            logger.info(
              `[Director API] Image generation resolution: ${imageWidth}x${imageHeight}`,
            );

            const fps = 30;
            const templateId =
              (template as
                | "Minimalist"
                | "ContentCreator"
                | "Corporate"
                | "TechDemo") ?? "Minimalist";

            const timeline: Array<
              | import("../../video/manifest/manifest-types.js").ImageSceneEntry
              | import("../../video/manifest/manifest-types.js").TitleCardEntry
              | import("../../video/manifest/manifest-types.js").TransitionEntry
              | import("../../video/manifest/manifest-types.js").OverlayEntry
            > = [];
            const sceneTiming: Array<{
              index: number;
              startTimeSec: number;
              endTimeSec: number;
              voiceover: string;
            }> = [];
            let currentFrame = 0;
            let skippedScenes = 0;
            // Base seed for per-scene variation — ensures each scene produces a
            // visually distinct image even when style anchors are shared.
            const baseSeed = Date.now() % 100_000;

            // Step C.1: Detect F5-TTS voice profile for presentation voiceover
            // When the audio sidecar has F5-TTS active, we synthesize
            // voiceover via the sidecar's /f5tts endpoint with the user's
            // voice profile clips, bypassing VoiceService (which only knows Kokoro).
            interface F5TTSClipRow {
              emotion: string;
              ref_audio_path: string;
              ref_text: string;
            }
            let f5ttsClips: F5TTSClipRow[] = [];
            let sidecarBaseUrl = "";
            let useF5TTSVoice = false;

            if (ctx.voiceService) {
              sidecarBaseUrl = ctx.voiceService.getSidecarUrl();
              try {
                const healthResp = await fetch(`${sidecarBaseUrl}/health`, {
                  signal: AbortSignal.timeout(3000),
                });
                if (healthResp.ok) {
                  const health = (await healthResp.json()) as {
                    active_engine?: string;
                  };
                  if (health.active_engine === "f5tts") {
                    // Load F5-TTS clips from the most recently updated F5-TTS profile
                    const db = getDatabase();
                    const f5Profile = db
                      .prepare(
                        `SELECT id FROM voice_profiles WHERE engine_type = 'f5tts'
                   ORDER BY updated_at DESC LIMIT 1`,
                      )
                      .get() as { id: string } | undefined;
                    if (f5Profile) {
                      const clips = db
                        .prepare(
                          `SELECT emotion, ref_audio_path, ref_text FROM f5tts_clips
                     WHERE profile_id = ? ORDER BY sort_order ASC`,
                        )
                        .all(f5Profile.id) as F5TTSClipRow[];
                      if (clips.length > 0) {
                        f5ttsClips = clips;
                        useF5TTSVoice = true;
                        logger.info(
                          `[Director API] F5-TTS voice detected — ${clips.length} clip(s) from profile ${f5Profile.id}`,
                        );
                      }
                    }
                  }
                }
              } catch {
                // Sidecar not reachable; fall back to VoiceService
              }
            }

            // ── Parallel image + voiceover generation ──────────────────────────
            // Images and voiceovers are independent — they typically run on
            // different machines/sidecars. By launching both streams concurrently,
            // total production time drops significantly compared to the old
            // sequential approach (image → audio → next scene).

            type SceneImageResult = {
              index: number;
              filePath: string | null;
              skipped: boolean;
            };
            type SceneVoiceResult = {
              index: number;
              voiceoverPath: string | undefined;
            };

            const generateSceneImage = async (
              scene: (typeof storyboard.scenes)[0],
            ): Promise<SceneImageResult> => {
              if (
                isAssetsOnlyMode &&
                scene.index > 0 &&
                scene.index < lastSceneIndex
              ) {
                const assetIndex = (scene.index - 1) % visualAssets!.length;
                const fp = visualAssets![assetIndex].path;
                logger.info(
                  `[Director API] Assets-only: scene ${scene.index + 1}/${storyboard.scenes.length} → ${fp}`,
                );
                return { index: scene.index, filePath: fp, skipped: false };
              }
              logger.info(
                `[Director API] Generating image ${scene.index + 1}/${storyboard.scenes.length}: ` +
                  `"${scene.rawImageDescription.substring(0, 60)}..."`,
              );
              try {
                const result = await imageService.generateImage(
                  scene.imagePrompt,
                  {
                    provider: resolvedImageProvider,
                    localModel: imageModel,
                    width: imageWidth,
                    height: imageHeight,
                    seed: baseSeed + scene.index * 1000,
                  },
                );
                return {
                  index: scene.index,
                  filePath: result.filePath,
                  skipped: false,
                };
              } catch (imgErr) {
                const imgMsg =
                  imgErr instanceof Error ? imgErr.message : String(imgErr);
                logger.error(
                  `[Director API] Image generation failed for scene ${scene.index}: ${imgMsg}`,
                );
                return { index: scene.index, filePath: null, skipped: true };
              }
            };

            const generateSceneVoiceover = async (
              scene: (typeof storyboard.scenes)[0],
            ): Promise<SceneVoiceResult> => {
              if (!scene.voiceover)
                return { index: scene.index, voiceoverPath: undefined };
              let voiceoverPath: string | undefined;

              if (useF5TTSVoice && f5ttsClips.length > 0 && ctx.voiceService) {
                try {
                  const f5Result = await ctx.voiceService.synthesizeF5TTS(
                    scene.voiceover,
                    f5ttsClips.map((c) => ({
                      emotion: c.emotion,
                      refAudioPath: c.ref_audio_path,
                      refText: c.ref_text,
                    })),
                  );
                  const voPath = path.join(
                    imageOutputDir,
                    `openzigs-vo-${nanoid(8)}.wav`,
                  );
                  await fs.writeFile(voPath, f5Result.audio);
                  voiceoverPath = voPath;
                  logger.info(
                    `[Director API] F5-TTS voiceover for scene ${scene.index}: ${f5Result.audio.length} bytes`,
                  );
                } catch (f5Err) {
                  const msg =
                    f5Err instanceof Error ? f5Err.message : String(f5Err);
                  const cause =
                    f5Err instanceof Error && f5Err.cause
                      ? ` (cause: ${f5Err.cause instanceof Error ? f5Err.cause.message : String(f5Err.cause)})`
                      : "";
                  logger.warn(
                    `[Director API] F5-TTS voiceover failed for scene ${scene.index}: ${msg}${cause}`,
                  );
                }
              } else if (ctx.voiceService) {
                try {
                  if (!ctx.voiceService.isReady()) {
                    logger.info(
                      `[Director API] Initializing Kokoro TTS for scene ${scene.index}`,
                    );
                    await ctx.voiceService.initialize();
                  }
                  if (ctx.voiceService.isReady()) {
                    const ttsResult = await ctx.voiceService.synthesize(
                      scene.voiceover,
                    );
                    const voPath = path.join(
                      imageOutputDir,
                      `openzigs-vo-${nanoid(8)}.mp3`,
                    );
                    await fs.writeFile(voPath, ttsResult.audio);
                    voiceoverPath = voPath;
                    logger.info(
                      `[Director API] Kokoro voiceover for scene ${scene.index}: ${ttsResult.audio.length} bytes`,
                    );
                  } else {
                    logger.warn(
                      `[Director API] Kokoro TTS not ready for scene ${scene.index} — skipping voiceover`,
                    );
                  }
                } catch (kokoroErr) {
                  const msg =
                    kokoroErr instanceof Error
                      ? kokoroErr.message
                      : String(kokoroErr);
                  logger.warn(
                    `[Director API] Kokoro voiceover failed for scene ${scene.index}: ${msg}`,
                  );
                }
              } else {
                logger.warn(
                  `[Director API] No TTS engine available for scene ${scene.index} — skipping voiceover`,
                );
              }

              return { index: scene.index, voiceoverPath };
            };

            // Launch image and voiceover generation concurrently.
            // Images: sequential per scene (cloud has QPM limits, local sidecar
            // processes one at a time) but runs IN PARALLEL with voiceover stream.
            // Voiceovers: sequential — F5-TTS is a single-threaded ML model that
            // crashes or drops connections under concurrent load. Serializing
            // ensures each scene gets a clean generation pass.
            checkAborted();
            emitActivity(
              "generating",
              `Generating images + voiceovers for ${storyboard.scenes.length} scenes in parallel`,
            );

            const imageGenStream = (async (): Promise<SceneImageResult[]> => {
              const results: SceneImageResult[] = [];
              for (const scene of storyboard.scenes) {
                checkAborted();
                if (resolvedImageProvider !== "local" && scene.index > 0) {
                  await new Promise((r) => setTimeout(r, 15_000));
                }
                results.push(await generateSceneImage(scene));
                emitActivity(
                  "images",
                  `Image ${results.length}/${storyboard.scenes.length} generated`,
                );
              }
              return results;
            })();

            const voiceGenStream = (async (): Promise<SceneVoiceResult[]> => {
              // Pre-flight: re-verify sidecar is still alive before burning time on TTS
              if (useF5TTSVoice && ctx.voiceService) {
                try {
                  const ping = await fetch(`${sidecarBaseUrl}/health`, {
                    signal: AbortSignal.timeout(5000),
                  });
                  if (!ping.ok) {
                    logger.warn(
                      `[Director API] Audio sidecar health check failed before voiceover generation (${ping.status}) — falling back to Kokoro`,
                    );
                    useF5TTSVoice = false;
                  }
                } catch {
                  logger.warn(
                    "[Director API] Audio sidecar unreachable before voiceover generation — falling back to Kokoro",
                  );
                  useF5TTSVoice = false;
                }
              }
              const engine = useF5TTSVoice ? "F5-TTS" : "Kokoro";
              logger.info(
                `[Director API] Starting voiceover generation (engine=${engine}, scenes=${storyboard.scenes.length})`,
              );
              const results: SceneVoiceResult[] = [];
              for (const scene of storyboard.scenes) {
                checkAborted();
                results.push(await generateSceneVoiceover(scene));
                emitActivity(
                  "voices",
                  `Voiceover ${results.length}/${storyboard.scenes.length} generated`,
                );
                logger.info(
                  `[Director API] Voiceover ${results.length}/${storyboard.scenes.length} complete (scene ${scene.index}, path=${results[results.length - 1].voiceoverPath ?? "none"})`,
                );
              }
              return results;
            })();

            const [imageResults, voiceResults] = await Promise.all([
              imageGenStream,
              voiceGenStream,
            ]);

            const imageMap = new Map(imageResults.map((r) => [r.index, r]));
            const voiceMap = new Map(voiceResults.map((r) => [r.index, r]));
            skippedScenes = imageResults.filter((r) => r.skipped).length;

            logger.info(
              `[Director API] Parallel generation complete: ${imageResults.length - skippedScenes} images, ${voiceResults.filter((v) => v.voiceoverPath).length} voiceovers`,
            );
            checkAborted();
            emitActivity("timeline", "Assembling timeline");

            // ── Phase 2: Assemble timeline using pre-generated results ──────────
            for (const scene of storyboard.scenes) {
              const imgResult = imageMap.get(scene.index);
              if (!imgResult || imgResult.skipped || !imgResult.filePath)
                continue;

              const sceneImageFilePath = imgResult.filePath;
              const sceneVoiceoverPath = voiceMap.get(
                scene.index,
              )?.voiceoverPath;

              let sceneDurationSec = scene.durationEstimate;
              if (sceneVoiceoverPath) {
                const measuredDuration =
                  await ctx.probeAudioDurationSeconds(sceneVoiceoverPath);
                if (measuredDuration && measuredDuration > 0) {
                  sceneDurationSec = Math.max(measuredDuration + 0.35, 2);
                }
              }

              const durationInFrames = Math.max(
                Math.round(sceneDurationSec * fps),
                fps,
              );

              // ── Chapter title card ──
              if (scene.chapterTitle) {
                const CHAPTER_CARD_DURATION = 90;

                if (timeline.length > 0) {
                  timeline.push({
                    type: "transition",
                    style: "crossfade",
                    duration: 15,
                    startAtFrame: currentFrame,
                  });
                }

                let separatorBackground: string | undefined;
                try {
                  const separatorPrompt =
                    `${storyboard.styleAnchor}. Abstract background for chapter separator card, ` +
                    `no text, atmospheric, thematic, high quality, cinematic`;
                  const separatorResult = await imageService.generateImage(
                    separatorPrompt,
                    {
                      provider: resolvedImageProvider,
                      localModel: imageModel,
                      width: imageWidth,
                      height: imageHeight,
                      seed: baseSeed + scene.index * 1000 + 500,
                    },
                  );
                  separatorBackground = separatorResult.filePath;
                } catch {
                  // Fallback: solid dark background (rendered by TitleCard component)
                }

                timeline.push({
                  type: "title_card",
                  title: scene.chapterTitle,
                  background: separatorBackground,
                  startAtFrame: currentFrame,
                  duration: CHAPTER_CARD_DURATION,
                  animation: "fade",
                });
                currentFrame += CHAPTER_CARD_DURATION;
              }

              const sceneStartFrame = currentFrame;

              if (timeline.length > 0) {
                const transitionDuration = Math.min(15, durationInFrames);
                timeline.push({
                  type: "transition",
                  style: "crossfade",
                  duration: transitionDuration,
                  startAtFrame: currentFrame,
                });
              }

              timeline.push({
                type: "image_scene",
                src: sceneImageFilePath,
                startAtFrame: currentFrame,
                duration: durationInFrames,
                voiceover: sceneVoiceoverPath,
                voiceoverVolume: 1.0,
                scriptText:
                  typeof scene.voiceover === "string"
                    ? scene.voiceover
                    : undefined,
                kenBurns: {
                  scaleFrom: 1.0,
                  scaleTo: 1.15,
                  translateXFrom: 0,
                  translateXTo: scene.index % 2 === 0 ? -10 : 10,
                  translateYFrom: 0,
                  translateYTo: -5,
                },
                textOverlays: scene.textOverlays,
              });

              currentFrame += durationInFrames;
              sceneTiming.push({
                index: scene.index,
                startTimeSec: sceneStartFrame / fps,
                endTimeSec: currentFrame / fps,
                voiceover: scene.voiceover,
              });
            }

            // Step D: Construct the DirectorManifest
            const resolvedMusicPath = musicTrackPath?.trim() || undefined;
            const manifest: import("../../video/manifest/manifest-types.js").DirectorManifest =
              {
                projectTitle: storyboard.title,
                templateId,
                composition: { width: 1920, height: 1080, fps },
                audioLayer: {
                  music: resolvedMusicPath
                    ? {
                        track: resolvedMusicPath,
                        volume: 0.08,
                        ducking: true,
                        fadeInFrames: 30,
                        fadeOutFrames: 30,
                        loop: true,
                      }
                    : null,
                  voiceover: null,
                },
                timeline,
                metadata: {
                  generatedAt: new Date().toISOString(),
                  llmModel: resolvedModel ?? "ctx.copilot",
                  llmTokensUsed: storyboard.tokensUsed,
                  productionMode: "presentation",
                  presenterQuizEnabled: !!quizEnabled,
                  sourceClips: [],
                  estimatedRenderTime: currentFrame / fps,
                },
              };

            // Step E: Recompute visual asset placements from final narration + measured scene timing,
            // then inject overlays into the timeline.
            if (visualAssets && visualAssets.length > 0) {
              const totalDurationSec = currentFrame / fps;
              let computedPlacements: Array<{
                id: string;
                startTimeSec: number;
                endTimeSec: number;
                position: string;
                scale: number;
              }> = [];

              try {
                const sceneTimelineText = sceneTiming
                  .map((scene) => {
                    const voice = scene.voiceover.replace(/\s+/g, " ").trim();
                    return `- scene ${scene.index + 1}: ${scene.startTimeSec.toFixed(2)}s → ${scene.endTimeSec.toFixed(2)}s | ${voice}`;
                  })
                  .join("\n");
                const assetListText = visualAssets
                  .map((asset, index) => {
                    const description = (
                      asset.description || path.basename(asset.path)
                    )
                      .replace(/\s+/g, " ")
                      .trim();
                    return `- id:${index} type:${asset.type} description:${description}`;
                  })
                  .join("\n");

                const placementPrompt = `You are placing visual overlays for a narrated video.

FINAL VIDEO DURATION: ${totalDurationSec.toFixed(2)} seconds

SCENE TIMELINE (already aligned to actual TTS audio durations):
${sceneTimelineText}

VISUAL ASSETS:
${assetListText}

Place each asset at the most semantically relevant moment in the narration.
For each asset, return:
- id (asset id)
- startTimeSec (seconds from 0)
- endTimeSec (must be > startTimeSec and <= ${totalDurationSec.toFixed(2)})
- position (top-left|top-center|top-right|center|bottom-left|bottom-center|bottom-right)
- scale (0.1 to 1.0)

Respond with ONLY a valid JSON array. No markdown, no explanation.`;

                const placementStream = ctx.copilot.chat(placementPrompt, {
                  tools: [],
                  ...(resolvedModel ? { model: resolvedModel } : {}),
                });
                const placementChunks: string[] = [];
                for await (const chunk of placementStream) {
                  placementChunks.push(chunk);
                }

                const rawPlacementText = placementChunks.join("");
                const rawPlacementJson = rawPlacementText
                  .replace(/```(?:json)?\s*/gi, "")
                  .replace(/```\s*/g, "")
                  .trim();
                const parsed = JSON.parse(rawPlacementJson) as unknown;
                if (Array.isArray(parsed)) {
                  computedPlacements = parsed
                    .map((entry) => {
                      if (!entry || typeof entry !== "object") return null;
                      const raw = entry as Record<string, unknown>;
                      const id = String(raw.id ?? "");
                      const startTimeSec = Number(raw.startTimeSec);
                      const endTimeSec = Number(raw.endTimeSec);
                      const position = String(raw.position ?? "bottom-right");
                      const scale = Number(raw.scale);
                      if (
                        !id ||
                        !Number.isFinite(startTimeSec) ||
                        !Number.isFinite(endTimeSec) ||
                        endTimeSec <= startTimeSec
                      ) {
                        return null;
                      }
                      return {
                        id,
                        startTimeSec,
                        endTimeSec,
                        position,
                        scale: Number.isFinite(scale) ? scale : 0.3,
                      };
                    })
                    .filter(
                      (entry): entry is NonNullable<typeof entry> =>
                        entry !== null,
                    );
                }
              } catch (placementErr) {
                const msg =
                  placementErr instanceof Error
                    ? placementErr.message
                    : String(placementErr);
                logger.warn(
                  `[Director API] Speech-aligned placement generation failed: ${msg}`,
                );
              }

              if (computedPlacements.length === 0) {
                const sceneWindows =
                  sceneTiming.length > 0
                    ? sceneTiming
                    : [
                        {
                          index: 0,
                          startTimeSec: 0,
                          endTimeSec: Math.max(totalDurationSec, 3),
                          voiceover: "",
                        },
                      ];
                const fallbackWindowSec = 4;

                computedPlacements = visualAssets.map((asset, index) => {
                  const scene =
                    sceneWindows[Math.min(index, sceneWindows.length - 1)]!;
                  const spanSec = Math.max(
                    scene.endTimeSec - scene.startTimeSec,
                    1,
                  );
                  const desiredDuration = Math.min(fallbackWindowSec, spanSec);
                  const startTimeSec = scene.startTimeSec;
                  const endTimeSec = Math.min(
                    scene.endTimeSec,
                    startTimeSec + desiredDuration,
                  );

                  return {
                    id: String(index),
                    startTimeSec,
                    endTimeSec,
                    position: asset.placement?.position ?? "bottom-right",
                    scale: asset.placement?.scale ?? 0.3,
                  };
                });

                logger.info(
                  `[Director API] Using deterministic fallback placement for ${computedPlacements.length} visual asset(s)`,
                );
              }

              const placementById = new Map(
                computedPlacements.map((placement) => [
                  placement.id,
                  placement,
                ]),
              );
              const validPositions = new Set([
                "top-left",
                "top-center",
                "top-right",
                "center",
                "bottom-left",
                "bottom-center",
                "bottom-right",
              ]);
              const clamp = (value: number, min: number, max: number) =>
                Math.min(max, Math.max(min, value));

              let overlaysInjected = 0;
              for (const [index, asset] of visualAssets.entries()) {
                const computed = placementById.get(String(index));
                const fallback = asset.placement ?? undefined;
                const selectedPlacement = computed ?? fallback;
                if (!selectedPlacement) continue;

                const startSec = clamp(
                  selectedPlacement.startTimeSec,
                  0,
                  Math.max(0, totalDurationSec - 0.5),
                );
                const endSec = clamp(
                  selectedPlacement.endTimeSec,
                  startSec + 0.5,
                  totalDurationSec,
                );
                const normalizedPosition = validPositions.has(
                  selectedPlacement.position,
                )
                  ? selectedPlacement.position
                  : "bottom-right";
                const normalizedScale = clamp(
                  Number.isFinite(selectedPlacement.scale)
                    ? selectedPlacement.scale
                    : 0.3,
                  0.1,
                  1.0,
                );

                const startFrame = Math.round(startSec * fps);
                const endFrame = Math.round(endSec * fps);
                const durationFrames = Math.max(endFrame - startFrame, fps); // minimum 1 second
                timeline.push({
                  type: "overlay",
                  component: "ImageOverlay",
                  props: {
                    src: asset.path,
                    position: normalizedPosition,
                    scale: normalizedScale,
                    isVideo: asset.type === "video",
                  },
                  startAtFrame: startFrame,
                  duration: durationFrames,
                } as import("../../video/manifest/manifest-types.js").OverlayEntry);
                overlaysInjected++;
              }
              if (overlaysInjected > 0) {
                logger.info(
                  `[Director API] Injected ${overlaysInjected} speech-aligned visual asset overlay(s) into timeline`,
                );
              }
            }

            const elapsedMs = Date.now() - startTime;

            const imageSceneCount = timeline.filter(
              (t) => t.type === "image_scene",
            ).length;
            logger.info(
              `[Director API] Presentation manifest: ${storyboard.scenes.length} scenes ` +
                `(${imageSceneCount} with images, ${skippedScenes} skipped), ` +
                `${timeline.filter((t) => t.type === "transition").length} transitions, ` +
                `${(currentFrame / fps).toFixed(1)}s total, ${elapsedMs}ms elapsed`,
            );

            if (skippedScenes > 0) {
              logger.warn(
                `[Director API] ${skippedScenes}/${storyboard.scenes.length} scenes skipped due to image generation failures. ` +
                  `Check that the image sidecar is running (http://127.0.0.1:5005/health) or configure GCP_PROJECT_ID for cloud images.`,
              );
            }

            if (imageSceneCount === 0) {
              logger.error(
                `[Director API] No images were generated — the presentation will be blank. Check image generation provider availability.`,
              );
            }

            job.status = "complete";
            job.completedAt = Date.now();
            job.result = {
              manifest,
              tokensUsed: storyboard.tokensUsed,
              clipsProcessed: 0,
              totalDuration: currentFrame / fps,
              processingTimeMs: elapsedMs,
              skippedScenes,
              imageProvider: resolvedImageProvider,
              imageModel: imageModel ?? "default",
              storyboard: {
                title: storyboard.title,
                styleAnchor: storyboard.styleAnchor,
                analysis: storyboard.analysis,
                sceneCount: storyboard.scenes.length,
              },
            };
            // Auto-save as a draft so the result survives navigation
            const db = getDatabase();
            const draftId = nanoid();
            const now = new Date().toISOString();
            const draftTitle = storyboard.title || "Untitled Presentation";
            db.prepare(
              `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
            ).run(
              draftId,
              draftTitle,
              JSON.stringify(manifest),
              null,
              "presentation",
              now,
              now,
            );
            job.result!.draftId = draftId;

            logger.info(
              `[Director API] Produce job ${produceJobId} complete (presentation, ${elapsedMs}ms) — draft ${draftId}`,
            );
            emitActivity(
              "complete",
              `Presentation ready (${(elapsedMs / 1000).toFixed(0)}s)`,
              { draftId, title: draftTitle },
            );
            return;
          }

          // ── Hero Reel mode: overview → storyboard → images → manifest (no TTS) ──
          if (mode === "hero-reel") {
            const startTime = Date.now();

            const path = await import("node:path");
            const os = await import("node:os");
            const { StoryboardEngine } =
              await import("../../video/generators/storyboard-engine.js");
            const { ImageGenService } =
              await import("../../video/generators/image-gen-service.js");

            checkAborted();
            emitActivity("storyboard", "Generating hero reel storyboard");
            const storyboardEngine = new StoryboardEngine(ctx.copilot);
            const resolvedModel =
              model || ctx.runtimeConfig.defaultModel || undefined;
            const clipDur =
              typeof defaultClipDuration === "number" &&
              defaultClipDuration >= 1 &&
              defaultClipDuration <= 10
                ? defaultClipDuration
                : 2;

            const storyboard = await storyboardEngine.generateHeroReel(
              heroReelOverview!,
              {
                model: resolvedModel,
                styleHint: topic,
                imageClipDurationSeconds: clipDur,
                userImages: heroReelImages?.map((img, i) => ({
                  index: i,
                  description: img.description,
                })),
                inspirationContext,
              },
            );

            logger.info(
              `[Director API] Hero reel storyboard: "${storyboard.title}" with ${storyboard.scenes.length} scenes`,
            );
            checkAborted();
            emitActivity(
              "images",
              `Generating images for ${storyboard.scenes.length} scenes`,
            );

            // Generate images
            const imageOutputDir = path.join(
              os.homedir(),
              ".openzigs",
              "director",
              "images",
            );
            const imageGenUserConfig =
              await ImageGenService.loadUserImageGenConfig();
            const imageService = new ImageGenService({
              outputDir: imageOutputDir,
              ...imageGenUserConfig,
            });
            await imageService.initialize();

            const resolvedImageProvider = imageProvider ?? "auto";
            const imageWidth = 768;
            const imageHeight = 432;
            const fps = 30;
            const templateId =
              (template as
                | "Minimalist"
                | "ContentCreator"
                | "Corporate"
                | "TechDemo") ?? "Minimalist";
            const baseSeed = Date.now() % 100_000;

            const timeline: Array<
              | import("../../video/manifest/manifest-types.js").ImageSceneEntry
              | import("../../video/manifest/manifest-types.js").TitleCardEntry
              | import("../../video/manifest/manifest-types.js").TransitionEntry
              | import("../../video/manifest/manifest-types.js").OverlayEntry
            > = [];
            let currentFrame = 0;
            let skippedScenes = 0;

            for (const scene of storyboard.scenes) {
              checkAborted();
              const prompt = scene.imagePrompt || storyboard.styleAnchor;
              let sceneImageFilePath: string | undefined;

              // Use user-provided image if the LLM assigned one
              const userImg =
                scene.userImageIndex !== undefined &&
                heroReelImages?.[scene.userImageIndex];
              if (userImg) {
                const fs = await import("node:fs/promises");
                try {
                  await fs.access(userImg.path);
                  // Enhance the user image with Kontext if there's a meaningful prompt
                  if (prompt && prompt.trim().length > 0) {
                    try {
                      const enhanced = await imageService.kontextEdit(
                        userImg.path,
                        `${storyboard.styleAnchor}. ${prompt}`,
                        {
                          width: imageWidth,
                          height: imageHeight,
                        },
                      );
                      sceneImageFilePath = enhanced.filePath;
                      logger.info(
                        `[Director API] Hero reel scene ${scene.index}: user image enhanced via Kontext (${enhanced.generationTimeMs}ms)`,
                      );
                    } catch (enhanceErr) {
                      logger.warn(
                        `[Director API] Hero reel scene ${scene.index}: Kontext enhance failed, using original image: ${enhanceErr instanceof Error ? enhanceErr.message : String(enhanceErr)}`,
                      );
                      sceneImageFilePath = userImg.path;
                    }
                  } else {
                    sceneImageFilePath = userImg.path;
                  }
                } catch {
                  logger.warn(
                    `[Director API] Hero reel scene ${scene.index}: user image not found at ${userImg.path}, falling back to AI generation`,
                  );
                }
              }

              // Fall back to AI image generation if no user image was used
              if (!sceneImageFilePath) {
                try {
                  const result = await imageService.generateImage(prompt, {
                    provider: resolvedImageProvider,
                    localModel: imageModel,
                    width: imageWidth,
                    height: imageHeight,
                    seed: baseSeed + scene.index * 1000,
                  });
                  sceneImageFilePath = result.filePath;
                } catch (imgErr) {
                  logger.warn(
                    `[Director API] Hero reel scene ${scene.index} image failed: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`,
                  );
                  skippedScenes++;
                  continue;
                }
              }

              emitActivity(
                "images",
                `Image ${scene.index + 1}/${storyboard.scenes.length} generated`,
              );

              const durationInFrames = Math.max(Math.round(clipDur * fps), fps);

              if (timeline.length > 0) {
                const transitionDuration = Math.min(10, durationInFrames);
                timeline.push({
                  type: "transition",
                  style: "crossfade",
                  duration: transitionDuration,
                  startAtFrame: currentFrame,
                });
              }

              timeline.push({
                type: "image_scene",
                src: sceneImageFilePath,
                startAtFrame: currentFrame,
                duration: durationInFrames,
                voiceover: undefined,
                voiceoverVolume: 0,
                scriptText: scene.voiceover,
                kenBurns: {
                  scaleFrom: 1.0,
                  scaleTo: 1.2,
                  translateXFrom: 0,
                  translateXTo: scene.index % 2 === 0 ? -12 : 12,
                  translateYFrom: 0,
                  translateYTo: -6,
                },
              });

              currentFrame += durationInFrames;
            }

            const resolvedMusicPath = musicTrackPath?.trim() || undefined;
            const manifest: import("../../video/manifest/manifest-types.js").DirectorManifest =
              {
                projectTitle: storyboard.title,
                templateId,
                composition: { width: 1920, height: 1080, fps },
                audioLayer: {
                  music: resolvedMusicPath
                    ? {
                        track: resolvedMusicPath,
                        volume: 0.15,
                        ducking: false,
                        fadeInFrames: 30,
                        fadeOutFrames: 30,
                        loop: true,
                      }
                    : null,
                  voiceover: null,
                },
                timeline,
                metadata: {
                  generatedAt: new Date().toISOString(),
                  llmModel: resolvedModel ?? "ctx.copilot",
                  llmTokensUsed: storyboard.tokensUsed,
                  productionMode: "hero-reel",
                  presenterQuizEnabled: false,
                  sourceClips: [],
                  estimatedRenderTime: currentFrame / fps,
                },
              };

            const elapsedMs = Date.now() - startTime;
            const imageSceneCount = timeline.filter(
              (t) => t.type === "image_scene",
            ).length;
            logger.info(
              `[Director API] Hero reel manifest: ${imageSceneCount} scenes, ` +
                `${(currentFrame / fps).toFixed(1)}s total, ${elapsedMs}ms elapsed`,
            );

            job.status = "complete";
            job.completedAt = Date.now();
            job.result = {
              manifest,
              tokensUsed: storyboard.tokensUsed,
              clipsProcessed: 0,
              totalDuration: currentFrame / fps,
              processingTimeMs: elapsedMs,
              skippedScenes,
              imageProvider: resolvedImageProvider,
              imageModel: imageModel ?? "default",
              storyboard: {
                title: storyboard.title,
                styleAnchor: storyboard.styleAnchor,
                analysis: storyboard.analysis,
                sceneCount: storyboard.scenes.length,
              },
            };
            // Auto-save as a draft so the result survives navigation
            const db = getDatabase();
            const draftId = nanoid();
            const now = new Date().toISOString();
            const draftTitle = storyboard.title || "Untitled Hero Reel";
            db.prepare(
              `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
            ).run(
              draftId,
              draftTitle,
              JSON.stringify(manifest),
              null,
              "hero-reel",
              now,
              now,
            );
            job.result!.draftId = draftId;

            logger.info(
              `[Director API] Produce job ${produceJobId} complete (hero-reel, ${elapsedMs}ms) — draft ${draftId}`,
            );
            emitActivity(
              "complete",
              `Hero reel ready (${(elapsedMs / 1000).toFixed(0)}s)`,
              { draftId, title: draftTitle },
            );
            return;
          }

          // ── Highlight / Script modes ──────────────────────────────
          emitActivity("ingestion", `${mode} mode — ingesting clips`);

          const startTime = Date.now();
          const progressLog: Array<{
            phase: string;
            message: string;
            timestamp: number;
          }> = [];

          // Vision analysis is enabled by default
          const useVision = enableVisionAnalysis !== false;

          // Ingest clips (with optional vision analysis)
          const { ingest } = await import("../../video/ingestion/index.js");
          const ingestionResult = await ingest(
            { clips: clips!, mode },
            {
              copilot: useVision ? ctx.copilot : undefined,
              visionAnalysis: useVision
                ? {
                    maxKeyframes: 30,
                    delayMs: 2000,
                    model: model || ctx.runtimeConfig.defaultModel || undefined,
                  }
                : undefined,
              onProgress: (event) => {
                progressLog.push({
                  phase: event.phase,
                  message: event.message,
                  timestamp: Date.now() - startTime,
                });
                logger.info(`[Director API] ${event.phase}: ${event.message}`);
              },
            },
          );

          // Produce manifest
          const { ProducerService } =
            await import("../../video/producer/producer-service.js");
          const producer = new ProducerService(ctx.copilot, ctx.voiceService);
          const resolvedMusicPath = musicTrackPath?.trim() || undefined;
          const result = await producer.produce({
            mode,
            contextPayload: ingestionResult.contextPayload,
            scriptPath,
            musicTrackPath: resolvedMusicPath,
            preferredTemplate: template,
            model: model || ctx.runtimeConfig.defaultModel || undefined,
            sourceClips: clips,
          });

          const elapsedMs = Date.now() - startTime;

          // Count effects and transitions for diagnostics
          const videoClipsInManifest = result.manifest.timeline.filter(
            (e) => e.type === "video_clip",
          );
          const transitionsInManifest = result.manifest.timeline.filter(
            (e) => e.type === "transition",
          );
          const clipsWithEffects = videoClipsInManifest.filter(
            (e) =>
              e.type === "video_clip" &&
              "effects" in e &&
              Array.isArray(e.effects) &&
              e.effects.length > 0,
          );
          const uniqueSources = new Set(
            videoClipsInManifest.map((e) =>
              e.type === "video_clip" ? e.source : "",
            ),
          );

          logger.info(
            `[Director API] Manifest stats: ${videoClipsInManifest.length} video clips from ${uniqueSources.size} source(s), ` +
              `${transitionsInManifest.length} transitions, ${clipsWithEffects.length} clips with effects`,
          );

          job.status = "complete";
          job.completedAt = Date.now();
          job.result = {
            manifest: result.manifest,
            tokensUsed: result.tokensUsed,
            clipsProcessed: ingestionResult.clips.length,
            totalDuration: ingestionResult.clips.reduce(
              (sum, c) => sum + c.duration,
              0,
            ),
            visionAnalysisEnabled: useVision,
            processingTimeMs: elapsedMs,
            progressLog,
            diagnostics: {
              videoClipCount: videoClipsInManifest.length,
              transitionCount: transitionsInManifest.length,
              clipsWithEffects: clipsWithEffects.length,
              uniqueSourcesUsed: uniqueSources.size,
              totalSourcesProvided: clips!.length,
            },
          };
          // Auto-save as a draft so the result survives navigation
          {
            const db = getDatabase();
            const draftId = nanoid();
            const now = new Date().toISOString();
            const draftTitle =
              ((result.manifest as unknown as Record<string, unknown>)
                .projectTitle as string) || `Untitled ${mode}`;
            db.prepare(
              `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
            ).run(
              draftId,
              draftTitle,
              JSON.stringify(result.manifest),
              null,
              mode,
              now,
              now,
            );
            job.result!.draftId = draftId;

            logger.info(
              `[Director API] Produce job ${produceJobId} complete (${mode}, ${elapsedMs}ms) — draft ${draftId}`,
            );
            emitActivity(
              "complete",
              `${mode} pipeline finished (${(elapsedMs / 1000).toFixed(0)}s)`,
              { draftId, title: draftTitle },
            );
          }
        } catch (bgError) {
          // Don't overwrite status if already cancelled by user
          if (job.status === "cancelled") return;
          const msg =
            bgError instanceof Error ? bgError.message : String(bgError);
          logger.error(
            `[Director API] Produce job ${produceJobId} failed: ${msg}`,
          );
          job.status = "failed";
          job.error = msg;
          job.completedAt = Date.now();
          emitActivity("failed", msg);
        }
      })();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /produce validation failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /produce/jobs — return all produce jobs (for activity monitoring).
   */
  router.get("/produce/jobs", (_req, res) => {
    const jobs = [...ctx.produceJobs.values()].map((j) => ({
      id: j.id,
      status: j.status,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      error: j.error,
      elapsedMs:
        j.status === "running"
          ? Date.now() - j.startedAt
          : (j.completedAt ?? j.startedAt) - j.startedAt,
    }));
    res.json({ jobs });
  });

  /**
   * GET /produce/:id — poll for produce job status.
   * Returns { status: "running" } while in progress, or the full produce result
   * when complete.
   */
  router.get("/produce/:id", (req, res) => {
    const job = ctx.produceJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Produce job not found" });
      return;
    }
    if (job.status === "running") {
      const elapsedMs = Date.now() - job.startedAt;
      res.json({ status: "running", elapsedMs });
      return;
    }
    if (job.status === "failed") {
      res.json({ status: "failed", error: job.error });
      return;
    }
    if (job.status === "cancelled") {
      res.json({ status: "cancelled", error: job.error });
      return;
    }
    // Complete — return the full result
    res.json({ status: "complete", ...job.result });
  });

  /**
   * POST /produce/:id/cancel — cancel a running produce pipeline.
   */
  router.post("/produce/:id/cancel", (req, res) => {
    const job = ctx.produceJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Produce job not found" });
      return;
    }
    if (job.status !== "running") {
      res.status(409).json({ error: `Job already ${job.status}` });
      return;
    }
    job.abort?.abort();
    job.status = "cancelled";
    job.error = "Cancelled by user";
    job.completedAt = Date.now();
    if (ctx.io()) {
      ctx.io()!.emit("produce:progress", {
        id: job.id,
        mode: "produce",
        phase: "cancelled",
        detail: "Cancelled by user",
        timestamp: Date.now(),
      });
    }
    logger.info(`[Director API] Produce job ${job.id} cancelled by user`);
    res.json({ success: true });
  });

  /**
   * GET /renders — list all drafts with their latest completed render (if any).
   * Queries director_drafts as the base so all presentations appear.
   */
  router.get("/renders", async (_req, res) => {
    try {
      const db = getDatabase();
      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      const rendersDir = pathMod.join(osMod.homedir(), ".openzigs", "renders");

      // Fetch all drafts.
      const drafts = db
        .prepare(
          `SELECT id, title, production_mode, updated_at FROM director_drafts ORDER BY updated_at DESC LIMIT 100`,
        )
        .all() as Array<{
        id: string;
        title: string;
        production_mode: string;
        updated_at: string;
      }>;

      // Fetch the latest render row per draft using a proper SQLite GROUP BY pattern.
      const renderRows = db
        .prepare(
          `SELECT r.draft_id, r.job_id, r.quality, r.status, r.output_path, r.created_at
           FROM director_renders r
           INNER JOIN (
             SELECT draft_id, MAX(created_at) AS max_created_at
             FROM director_renders
             GROUP BY draft_id
           ) latest ON r.draft_id = latest.draft_id AND r.created_at = latest.max_created_at`,
        )
        .all() as Array<{
        draft_id: string;
        job_id: string;
        quality: string;
        status: string;
        output_path: string | null;
        created_at: string;
      }>;

      const renderByDraft = new Map<string, (typeof renderRows)[0]>();
      for (const r of renderRows) renderByDraft.set(r.draft_id, r);

      const renders = drafts.map((d) => {
        const r = renderByDraft.get(d.id);
        const liveJob = r
          ? ctx.renderOrchestrator?.getJob(r.job_id)
          : undefined;

        // Resolve output path: live job → DB row → filesystem probe for historical renders.
        let resolvedPath: string | null =
          liveJob?.outputPath ?? r?.output_path ?? null;
        if (!resolvedPath && r?.job_id) {
          // Historical renders (pre-persistence hook) may have the file on disk but
          // null in the DB. Scan the job's output directory for any .mp4 file.
          const jobDir = pathMod.join(rendersDir, r.job_id);
          if (fsMod.existsSync(jobDir)) {
            const files = fsMod
              .readdirSync(jobDir)
              .filter((f) => f.endsWith(".mp4"));
            if (files.length > 0) {
              resolvedPath = pathMod.join(jobDir, files[0]);
              // Back-fill the DB so future requests are instant.
              db.prepare(
                `UPDATE director_renders SET output_path = ?, status = 'complete', updated_at = ? WHERE job_id = ?`,
              ).run(resolvedPath, new Date().toISOString(), r.job_id);
            }
          }
        }

        const resolvedStatus =
          liveJob?.status ?? (resolvedPath ? "complete" : (r?.status ?? null));
        return {
          draftId: d.id,
          draftTitle: d.title,
          productionMode: d.production_mode,
          quality: r?.quality ?? null,
          status: resolvedStatus,
          outputPath: resolvedPath,
          downloadUrl:
            resolvedPath && r?.job_id
              ? `/api/admin/director/renders/${r.job_id}/download`
              : null,
          updatedAt: d.updated_at,
        };
      });

      res.json({ renders });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /renders failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /renders/:jobId/download — stream a completed render file as an attachment.
   */
  router.get("/renders/:jobId/download", async (req, res) => {
    try {
      const fsMod = await import("node:fs");

      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT r.output_path, d.title
         FROM director_renders r
         JOIN director_drafts d ON d.id = r.draft_id
         WHERE r.job_id = ?`,
        )
        .get(req.params.jobId) as
        | { output_path: string | null; title: string }
        | undefined;

      // Also check live job state in case DB hasn't been flushed yet
      const liveJob = ctx.renderOrchestrator?.getJob(req.params.jobId);
      const outputPath = liveJob?.outputPath ?? row?.output_path ?? null;

      if (!outputPath) {
        res.status(404).json({ error: "Render not found or not yet complete" });
        return;
      }

      if (!fsMod.existsSync(outputPath)) {
        res.status(404).json({ error: "Render file not found on disk" });
        return;
      }

      const safeTitle =
        (row?.title ?? "render")
          .replace(/[^a-zA-Z0-9_\- ]/g, "")
          .trim()
          .replace(/\s+/g, "_") || "render";
      const fileName = `${safeTitle}_${req.params.jobId.slice(0, 8)}.mp4`;

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      fsMod.createReadStream(outputPath).pipe(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] GET /renders/:jobId/download failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /shorts — convert a long-form video into a 30–60s YouTube Short.
   * Body: { sourceVideo: string, style?: string, targetDuration?: number, voiceProfile?: string }
   * Response: { draftId: string, manifest, viralClip, scriptText, processingTimeMs }
   */
  router.post("/shorts", async (req, res) => {
    try {
      const { sourceVideo, style, targetDuration, voiceProfile } = req.body as {
        sourceVideo?: string;
        style?: "react" | "summarize" | "highlight";
        targetDuration?: number;
        voiceProfile?: string;
      };

      if (!sourceVideo || typeof sourceVideo !== "string") {
        res.status(400).json({ error: "sourceVideo is required" });
        return;
      }

      if (sourceVideo.includes("..") || sourceVideo.includes("\0")) {
        res.status(400).json({ error: "Invalid sourceVideo path" });
        return;
      }

      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(sourceVideo)) {
        res
          .status(404)
          .json({ error: `Source video not found: ${sourceVideo}` });
        return;
      }

      if (!ctx.voiceService) {
        res.status(503).json({
          error: "VoiceService is not available — Shorts pipeline requires TTS",
        });
        return;
      }

      const { createShort } =
        await import("../../video/shorts/shorts-pipeline.js");
      const result = await createShort(
        {
          sourceVideo,
          style: style ?? "highlight",
          targetDuration: targetDuration ?? 45,
          voiceProfile,
          model: ctx.runtimeConfig.defaultModel || undefined,
        },
        ctx.copilot,
        ctx.voiceService,
      );

      // Auto-save as a draft
      const db = getDatabase();
      const draftId = nanoid();
      const now = new Date().toISOString();
      const title = result.manifest.projectTitle || "Untitled Short";

      db.prepare(
        `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(
        draftId,
        title,
        JSON.stringify(result.manifest),
        null,
        "shorts",
        now,
        now,
      );

      logger.info(
        `[Director API] Short created as draft ${draftId}: "${title}"`,
      );

      res.json({
        draftId,
        manifest: result.manifest,
        viralClip: result.viralClip,
        scriptText: result.scriptText,
        processingTimeMs: result.processingTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /shorts failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /render — submit a manifest for rendering.
   * Body: { manifest: DirectorManifest, codec?, crf?, quality? }
   *
   * Quality presets:
   *   "draft"   — crf 32, fast encode
   *   "standard" — crf 23, balanced
   *   "high"    — crf 18, high quality
   *   "lossless" — crf 0, maximum quality
   */
  router.post("/render", async (req, res) => {
    try {
      if (!ctx.renderOrchestrator) {
        res.status(503).json({ error: "Render orchestrator is not available" });
        return;
      }

      const {
        manifest,
        codec,
        crf,
        quality,
        draftId,
        notifyViaTelegram,
        telegramChatId,
      } = req.body as {
        manifest: unknown;
        codec?: string;
        crf?: number;
        quality?: "draft" | "standard" | "high" | "lossless";
        draftId?: string;
        notifyViaTelegram?: boolean;
        telegramChatId?: string;
      };
      if (!manifest || typeof manifest !== "object") {
        res.status(400).json({ error: "manifest object is required" });
        return;
      }

      // Quality preset → crf mapping
      const qualityPresets: Record<string, number> = {
        draft: 32,
        standard: 23,
        high: 18,
        lossless: 0,
      };

      const resolvedCrf =
        crf ?? (quality ? qualityPresets[quality] : undefined);

      const jobId = await ctx.renderOrchestrator.submit({
        manifest:
          manifest as import("../../video/manifest/manifest-types.js").DirectorManifest,
        notifyViaTelegram,
        telegramChatId,
      });

      // Store quality metadata on the job for logging/display
      const job = ctx.renderOrchestrator.getJob(jobId);
      if (job) {
        const jobMeta = job as typeof job & {
          codec?: string;
          crf?: number;
          quality?: string;
          draftId?: string;
        };
        jobMeta.codec = codec ?? "h264";
        jobMeta.crf = resolvedCrf ?? 23;
        jobMeta.quality = quality ?? "standard";
        jobMeta.draftId = draftId;
      }

      // Record render in history if linked to a draft
      if (draftId) {
        const db = getDatabase();
        const now = new Date().toISOString();
        const renderId = nanoid();
        db.prepare(
          `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(renderId, draftId, jobId, quality ?? "standard", now, now);
      }

      res.json({
        jobId,
        status: "queued",
        codec: codec ?? "h264",
        crf: resolvedCrf ?? 23,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /render failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /jobs — list all render jobs.
   */
  router.get("/jobs", (_req, res) => {
    if (!ctx.renderOrchestrator) {
      res.json({ jobs: [] });
      return;
    }
    const jobs = ctx.renderOrchestrator.listJobs().map((j) => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      projectTitle: j.manifest.projectTitle,
      templateId: j.manifest.templateId,
      outputPath: j.outputPath,
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      durationSec: j.durationSec,
      fileSizeBytes: j.fileSizeBytes,
    }));
    res.json({ jobs });
  });

  /**
   * GET /jobs/:id — get render job details.
   */
  router.get("/jobs/:id", (req, res) => {
    if (!ctx.renderOrchestrator) {
      res.status(404).json({ error: "Render orchestrator not available" });
      return;
    }
    const job = ctx.renderOrchestrator.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${req.params.id}` });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      projectTitle: job.manifest.projectTitle,
      templateId: job.manifest.templateId,
      outputPath: job.outputPath,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      durationSec: job.durationSec,
      fileSizeBytes: job.fileSizeBytes,
    });
  });

  /**
   * POST /jobs/:id/abort — abort a render job.
   */
  router.post("/jobs/:id/abort", (req, res) => {
    if (!ctx.renderOrchestrator) {
      res.status(503).json({ error: "Render orchestrator not available" });
      return;
    }
    const aborted = ctx.renderOrchestrator.abort(req.params.id);
    res.json({ success: aborted });
  });

  router.post("/render/batch", async (req, res) => {
    try {
      const { draftIds } = req.body as { draftIds?: string[] };
      if (!Array.isArray(draftIds) || draftIds.length === 0) {
        res.status(400).json({ error: "draftIds array is required" });
        return;
      }

      const db = getDatabase();
      const results: Array<{
        draftId: string;
        jobId?: string;
        error?: string;
      }> = [];

      // Process sequentially to avoid overwhelming the render queue
      for (const draftId of draftIds) {
        try {
          const row = db
            .prepare(`SELECT id, manifest FROM director_drafts WHERE id = ?`)
            .get(draftId) as
            | {
                id: string;
                manifest: string;
              }
            | undefined;

          if (!row) {
            results.push({ draftId, error: "Draft not found" });
            continue;
          }

          let manifest: Record<string, unknown>;
          try {
            manifest = JSON.parse(row.manifest);
          } catch {
            results.push({ draftId, error: "Corrupt manifest" });
            continue;
          }

          if (!ctx.renderOrchestrator) {
            results.push({
              draftId,
              error: "Render orchestrator not available",
            });
            continue;
          }

          const jobId = nanoid();
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
             VALUES (?, ?, ?, 'standard', 'queued', ?, ?)`,
          ).run(nanoid(), draftId, jobId, now, now);

          await ctx.renderOrchestrator.submit({
            manifest: manifest as never,
          });

          results.push({ draftId, jobId });
        } catch (err) {
          results.push({
            draftId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const completed = results.filter((r) => r.jobId).length;
      const failed = results.filter((r) => r.error).length;
      res.json({ total: draftIds.length, queued: completed, failed, results });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /render/batch failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/shorts/from-manifest", async (req, res) => {
    try {
      const { draftId, maxClips } = req.body as {
        draftId?: string;
        maxClips?: number;
      };
      if (!draftId || typeof draftId !== "string") {
        res.status(400).json({ error: "draftId is required" });
        return;
      }

      const db = getDatabase();
      const row = db
        .prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as
        | {
            title: string;
            manifest: string;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        res.status(500).json({ error: "Corrupt manifest" });
        return;
      }

      const timeline = Array.isArray(manifest.timeline)
        ? manifest.timeline
        : [];
      if (timeline.length === 0) {
        res.status(400).json({ error: "Manifest has no timeline scenes" });
        return;
      }

      // Use LLM to identify most engaging segments
      const sceneDescriptions = timeline
        .map((s: Record<string, unknown>, i: number) => {
          const text =
            (s.scriptText as string) || (s.title as string) || `Scene ${i + 1}`;
          const dur = typeof s.duration === "number" ? s.duration : 5000;
          return `[${i}] (${Math.round(dur < 1000 ? dur : dur / 1000)}s) ${text.slice(0, 200)}`;
        })
        .join("\n");

      const limit = Math.min(maxClips || 3, 5);
      const prompt = `You are a viral content strategist. Analyze these video scenes and select up to ${limit} segments that would make the most engaging YouTube Shorts (max 60 seconds each).

SCENES:
${sceneDescriptions}

For each Short, respond with JSON only (no markdown fences):
[
  {
    "startSceneIndex": 0,
    "endSceneIndex": 2,
    "title": "Hook title for the Short",
    "hookText": "Opening hook text overlay",
    "ctaText": "Call to action text",
    "reason": "Why this segment is engaging"
  }
]`;

      const seoModel = await getUserSelectedModel();
      const stream = ctx.copilot.chat(prompt, {
        tools: [],
        ...(seoModel ? { model: seoModel } : {}),
      });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const rawResponse = chunks.join("").trim();
      let suggestions: Array<{
        startSceneIndex: number;
        endSceneIndex: number;
        title: string;
        hookText: string;
        ctaText: string;
        reason: string;
      }>;

      try {
        const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array found");
        suggestions = JSON.parse(jsonMatch[0]);
      } catch {
        res
          .status(500)
          .json({ error: "Failed to parse LLM response", raw: rawResponse });
        return;
      }

      // Validate and enrich suggestions
      const enriched = suggestions.slice(0, limit).map((s) => {
        const startIdx = Math.max(
          0,
          Math.min(s.startSceneIndex, timeline.length - 1),
        );
        const endIdx = Math.max(
          startIdx,
          Math.min(s.endSceneIndex, timeline.length - 1),
        );
        const scenes = timeline.slice(startIdx, endIdx + 1);
        const totalDurationMs = scenes.reduce(
          (acc: number, sc: Record<string, unknown>) => {
            const d = typeof sc.duration === "number" ? sc.duration : 5000;
            return acc + (d < 1000 ? d * 1000 : d);
          },
          0,
        );

        return {
          ...s,
          startSceneIndex: startIdx,
          endSceneIndex: endIdx,
          sceneCount: scenes.length,
          estimatedDurationMs: totalDurationMs,
          cropConfig: { aspectRatio: "9:16", width: 1080, height: 1920 },
        };
      });

      res.json({ suggestions: enriched, totalScenes: timeline.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /shorts/from-manifest failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /drafts/:draftId/shorts/render — Accept selected Short segments and
   * create new Short drafts + queue them for rendering.
   * Body: { segments: Array<{ startTime, endTime, title, hookText, ctaText, burnSubtitles? }> }
   * Response: { jobIds: string[] }
   */
  router.post("/drafts/:draftId/shorts/render", async (req, res) => {
    try {
      const { draftId } = req.params;
      const segmentSchema = z.object({
        startTime: z.number(),
        endTime: z.number(),
        title: z.string(),
        hookText: z.string().optional().default(""),
        ctaText: z.string().optional().default(""),
        burnSubtitles: z.boolean().optional().default(false),
      });
      const bodySchema = z.object({
        segments: z
          .array(segmentSchema)
          .min(1, "At least one segment is required"),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const db = getDatabase();
      const parentDraft = db
        .prepare(`SELECT id, title, manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as
        | {
            id: string;
            title: string;
            manifest: string;
          }
        | undefined;

      if (!parentDraft) {
        res.status(404).json({ error: "Parent draft not found" });
        return;
      }

      let parentManifest: Record<string, unknown>;
      try {
        parentManifest = JSON.parse(parentDraft.manifest);
      } catch {
        res.status(500).json({ error: "Corrupt parent manifest" });
        return;
      }

      const jobIds: string[] = [];

      const parentComposition =
        (parentManifest.composition as Record<string, unknown>) || {};
      const parentFps =
        typeof parentComposition.fps === "number" && parentComposition.fps > 0
          ? parentComposition.fps
          : 30;
      const parentTimeline = Array.isArray(parentManifest.timeline)
        ? (parentManifest.timeline as Array<Record<string, unknown>>)
        : [];

      // Find the primary video source from the parent timeline
      const primaryVideoEntry = parentTimeline.find(
        (e) => e.type === "video_clip" && (e.source || e.src),
      );
      const primaryVideoSource =
        (primaryVideoEntry?.source as string) ??
        (primaryVideoEntry?.src as string) ??
        "";

      for (const seg of parsed.data.segments) {
        const shortDraftId = nanoid();
        const jobId = nanoid();
        const now = new Date().toISOString();

        const segDurationSec = seg.endTime - seg.startTime;
        const segDurationFrames = Math.round(segDurationSec * parentFps);

        let shortsTimeline: Array<Record<string, unknown>>;

        if (primaryVideoSource) {
          // Single video_clip: trim to the selected time range
          shortsTimeline = [
            {
              type: "video_clip",
              source: primaryVideoSource,
              title: seg.title,
              startAtFrame: 0,
              trimStart: seg.startTime,
              trimEnd: seg.endTime,
              duration: segDurationFrames,
              durationInFrames: segDurationFrames,
            },
          ];
        } else {
          // Multi-scene/presentation: filter to scenes overlapping the selected window
          let cumulativeSec = 0;
          const scenesWithTime = parentTimeline.map((entry) => {
            const dur =
              typeof entry.duration === "number"
                ? entry.duration / parentFps
                : typeof entry.durationInFrames === "number"
                  ? (entry.durationInFrames as number) / parentFps
                  : 5;
            const start = cumulativeSec;
            cumulativeSec += dur;
            return { entry, startSec: start, endSec: cumulativeSec };
          });

          // Keep scenes that overlap with [seg.startTime, seg.endTime]
          const filtered = scenesWithTime.filter(
            (s) => s.endSec > seg.startTime && s.startSec < seg.endTime,
          );

          // Recompute startAtFrame sequentially for the filtered timeline
          let frame = 0;
          shortsTimeline = filtered.map((s) => {
            const dur =
              typeof s.entry.duration === "number"
                ? (s.entry.duration as number)
                : typeof s.entry.durationInFrames === "number"
                  ? (s.entry.durationInFrames as number)
                  : Math.round(5 * parentFps);
            const updated = { ...s.entry, startAtFrame: frame };
            frame += dur;
            return updated;
          });

          if (shortsTimeline.length === 0) {
            shortsTimeline = parentTimeline;
          }
        }

        // YouTube Shorts: vertical 9:16 at 1080×1920 using the ContentCreator composition
        // (parent drafts may use 16:9 templates — do not inherit templateId for Short output).
        const shortsManifest = {
          ...parentManifest,
          templateId: "ContentCreator",
          projectTitle: seg.title,
          composition: {
            ...parentComposition,
            width: 1080,
            height: 1920,
          },
          timeline: shortsTimeline,
          shortsMetadata: {
            parentDraftId: draftId,
            startTime: seg.startTime,
            endTime: seg.endTime,
            hookText: seg.hookText,
            ctaText: seg.ctaText,
            burnSubtitles: seg.burnSubtitles,
          },
        };

        db.prepare(
          `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        ).run(
          shortDraftId,
          seg.title,
          JSON.stringify(shortsManifest),
          null,
          "shorts",
          now,
          now,
        );

        db.prepare(
          `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
           VALUES (?, ?, ?, 'standard', 'queued', ?, ?)`,
        ).run(nanoid(), shortDraftId, jobId, now, now);

        if (ctx.renderOrchestrator) {
          await ctx.renderOrchestrator.submit({
            manifest: shortsManifest as never,
          });
        }

        jobIds.push(jobId);
      }

      logger.info(
        `[Director API] Queued ${jobIds.length} Short render(s) from draft ${draftId}`,
      );
      res.json({ jobIds });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /drafts/:draftId/shorts/render failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });
}
