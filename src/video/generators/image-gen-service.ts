/**
 * Director Mode — Image Generation Service
 * Issue #254: Dual-provider image generation with cloud/local failover.
 *
 * Cloud Route:  Google Vertex AI (Imagen 3) via @google-cloud/aiplatform
 * Local Route:  HTTP POST to Python sidecar (Flux.1 schnell / SDXL Turbo on MPS)
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Agent } from "undici";
import { logger } from "../../logging/logger.js";

// Optional dependency — loaded dynamically at runtime to avoid hard compile-time requirement.
// Bypass TS static module resolution by constructing the specifier at runtime.
const AIPLATFORM_PKG = ["@google-cloud", "aiplatform"].join("/");

// ── Types ─────────────────────────────────────────────────────

export type ImageProvider = "cloud" | "local" | "auto";

export interface ImageGenOptions {
  /** Which provider to use (default: "auto" — try cloud, fallback to local) */
  provider?: ImageProvider;
  /** Which local sidecar model to use (e.g. "flux", "sdxl-base"). Ignored for cloud provider. */
  localModel?: string;
  /** Image width in pixels (default: 1024) */
  width?: number;
  /** Image height in pixels (default: 1024) */
  height?: number;
  /** Negative prompt — what to avoid (cloud only) */
  negativePrompt?: string;
  /** Random seed for reproducibility */
  seed?: number;
  /** Number of inference steps (local only, default: model-specific) */
  steps?: number;
  /** LoRA adapter paths for character consistency */
  loraPaths?: string[];
  /** LoRA scale factors (one per adapter) */
  loraScales?: number[];
  /** ControlNet reference image path */
  controlnetImagePath?: string;
  /** ControlNet influence strength (0.0-1.0) */
  controlnetStrength?: number;
  /** ControlNet type: "canny" or "depth" */
  controlType?: "canny" | "depth";
}

export interface ImageGenResult {
  /** Path to the generated PNG file */
  filePath: string;
  /** Which provider actually generated the image */
  provider: "cloud" | "local";
  /** Generation time in milliseconds */
  generationTimeMs: number;
  /** Image dimensions */
  width: number;
  height: number;
}

export interface ImageGenServiceConfig {
  /** Google Cloud project ID for Vertex AI */
  gcpProjectId?: string;
  /** Google Cloud region (default: "us-central1") */
  gcpRegion?: string;
  /** Imagen model name (default: "imagen-3.0-generate-001") */
  imagenModel?: string;
  /** Local sidecar URL (default: "http://127.0.0.1:5005") */
  localSidecarUrl?: string;
  /** Timeout for cloud requests in ms (default: 60000) */
  cloudTimeoutMs?: number;
  /** Timeout for local requests in ms (default: 600000 — 10 min to cover first-time model downloads) */
  localTimeoutMs?: number;
  /** Directory to save generated images (default: os.tmpdir()) */
  outputDir?: string;
  /** Image-gen mode: "local" (same machine sidecar) or "network" (remote FluxQ node) */
  imageGenMode?: "local" | "network";
  /** URL of the remote FluxQ network node (e.g. "http://192.168.1.50:5005") */
  networkNodeUrl?: string;
  /** Bearer token for authenticating with the remote FluxQ node */
  networkNodeToken?: string;
}

// ── Constants ─────────────────────────────────────────────────

// Lazy factory — process.env must be read at construction time, not at
// module load time; ESM evaluates top-level constants before dotenv/config
// side-effects run when the import graph is resolved in certain orders.
function getDefaultConfig(): Required<ImageGenServiceConfig> {
  return {
    gcpProjectId: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "",
    gcpRegion: process.env.GCP_REGION ?? "us-central1",
    imagenModel: "imagen-3.0-generate-001",
    localSidecarUrl: process.env.IMAGE_GEN_SIDECAR_URL ?? "http://127.0.0.1:5005",
    cloudTimeoutMs: 60_000,
    // The local sidecar can take a long time to download models or run a heavy
    // kontext edit. 20 minutes (1,200,000 ms) gives ample headroom; callers may
    // still override via USER config if they want shorter timeouts.
    localTimeoutMs: 1_200_000,
    outputDir: path.join(os.tmpdir(), "openzigs-image-gen"),
    imageGenMode: (process.env.IMAGE_GEN_MODE as "local" | "network" | undefined) ?? "local",
    networkNodeUrl: process.env.IMAGE_GEN_NETWORK_URL ?? "",
    networkNodeToken: process.env.IMAGE_GEN_NETWORK_TOKEN ?? process.env.FLUXQ_SECRET_TOKEN ?? "",
  };
}

// ── Service ───────────────────────────────────────────────────

export class ImageGenService {
  private readonly config: Required<ImageGenServiceConfig>;
  private _cloudAvailable: boolean | null = null;
  private _localAvailable: boolean | null = null;

  /** Whether the cloud provider is known to be available. */
  get cloudAvailable(): boolean | null { return this._cloudAvailable; }
  /** Whether the local sidecar is known to be available. */
  get localAvailable(): boolean | null { return this._localAvailable; }

  /** The effective sidecar URL: network node URL if in network mode, else local. */
  get effectiveSidecarUrl(): string {
    if (this.config.imageGenMode === "network" && this.config.networkNodeUrl) {
      return this.config.networkNodeUrl.replace(/\/$/, "");
    }
    return this.config.localSidecarUrl;
  }

  /** Whether network mode is active. */
  get isNetworkMode(): boolean {
    return this.config.imageGenMode === "network" && !!this.config.networkNodeUrl;
  }

  constructor(config?: ImageGenServiceConfig) {
    this.config = { ...getDefaultConfig(), ...config };
  }

  /**
   * Create an undici Agent with headersTimeout/bodyTimeout matching localTimeoutMs.
   * Node.js fetch() uses undici internally; its default headersTimeout (300s)
   * is far too short for Kontext edits (~15 min). Passing a custom dispatcher
   * overrides those defaults so the AbortSignal is the sole timeout authority.
   */
  private longRunningDispatcher(): Agent {
    return new Agent({
      headersTimeout: this.config.localTimeoutMs,
      bodyTimeout: this.config.localTimeoutMs,
      connectTimeout: 30_000,
    });
  }

  /**
   * Load imageGen config from the user config file (~/.openzigs/config.json).
   * Returns partial config suitable for spreading into the constructor.
   */
  static async loadUserImageGenConfig(): Promise<Partial<ImageGenServiceConfig>> {
    try {
      const configPath = process.env.OPENZIGS_CONFIG_PATH
        ?? path.join(os.homedir(), ".openzigs", "config.json");
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const ig = parsed.imageGen as Record<string, unknown> | undefined;
      if (!ig) return {};
      const result: Partial<ImageGenServiceConfig> = {};
      if (ig.mode === "local" || ig.mode === "network") result.imageGenMode = ig.mode;
      if (typeof ig.networkNodeUrl === "string" && ig.networkNodeUrl) result.networkNodeUrl = ig.networkNodeUrl;
      if (typeof ig.networkNodeToken === "string" && ig.networkNodeToken) result.networkNodeToken = ig.networkNodeToken;
      // If config has no token, fall back to the sidecar's own env var so
      // local co-located deployments work without extra configuration.
      if (!result.networkNodeToken && process.env.FLUXQ_SECRET_TOKEN) {
        result.networkNodeToken = process.env.FLUXQ_SECRET_TOKEN;
      }
      if (typeof ig.localTimeoutMs === "number" && ig.localTimeoutMs > 0) result.localTimeoutMs = ig.localTimeoutMs;
      return result;
    } catch {
      return {};
    }
  }

  /**
   * Initialize the service — create output directory.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.config.outputDir, { recursive: true });
    logger.info(`[ImageGenService] Initialized (output: ${this.config.outputDir})`);
  }

  /**
   * Generate an image from a text prompt.
   *
   * @param prompt   - Text description of the desired image
   * @param options  - Generation options (provider, dimensions, etc.)
   * @returns          Result with file path and metadata
   */
  async generateImage(prompt: string, options: ImageGenOptions = {}): Promise<ImageGenResult> {
    const provider = options.provider ?? "auto";
    const width = options.width ?? 1024;
    const height = options.height ?? 1024;

    await fs.mkdir(this.config.outputDir, { recursive: true });

    if (provider === "cloud") {
      return this.generateCloud(prompt, width, height, options);
    }

    if (provider === "local") {
      return this.generateLocal(prompt, width, height, options);
    }

    // Auto mode: prefer local sidecar when configured (avoids unnecessary cloud costs),
    // fall back to cloud only if local fails.
    try {
      return await this.generateLocal(prompt, width, height, options);
    } catch (localError) {
      const localMsg = localError instanceof Error ? localError.message : String(localError);
      logger.warn(`[ImageGenService] Local generation failed: ${localMsg} — falling back to cloud`);

      try {
        return await this.generateCloud(prompt, width, height, options);
      } catch (cloudError) {
        const cloudMsg = cloudError instanceof Error ? cloudError.message : String(cloudError);
        throw new Error(
          `Image generation failed on both providers. Local: ${localMsg}. Cloud: ${cloudMsg}`,
        );
      }
    }
  }

  /**
   * Check availability of both providers.
   */
  async checkHealth(): Promise<{ cloud: boolean; local: boolean }> {
    const [cloud, local] = await Promise.all([
      this.checkCloudHealth(),
      this.checkLocalHealth(),
    ]);
    return { cloud, local };
  }

  /**
   * Query the local sidecar for its recommended image resolution.
   * Returns null if the sidecar is unavailable or doesn't support this.
   *
   * Diffusion models have native training resolutions (e.g. 512x512 for
   * SDXL Turbo, 1024x1024 for Flux). Generating at much higher resolutions
   * produces degenerate outputs where the model can't differentiate prompts.
   */
  async getRecommendedResolution(): Promise<{ width: number; height: number } | null> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.networkNodeToken) {
        headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
      }
      const response = await fetch(`${this.effectiveSidecarUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json() as {
        ready?: boolean;
        recommended_width?: number;
        recommended_height?: number;
      };
      if (data.ready && data.recommended_width && data.recommended_height) {
        return { width: data.recommended_width, height: data.recommended_height };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Cloud Provider (Google Vertex AI Imagen) ────────────────

  private async generateCloud(
    prompt: string,
    width: number,
    height: number,
    options: ImageGenOptions,
  ): Promise<ImageGenResult> {
    if (!this.config.gcpProjectId) {
      throw new Error("GCP_PROJECT_ID not configured — cannot use cloud image generation");
    }

    const start = Date.now();

    // Determine aspect ratio from dimensions
    const aspectRatio = this.resolveAspectRatio(width, height);

    let client: { close?: () => Promise<void> } | null = null;

    try {
      // Use the Vertex AI prediction endpoint via @google-cloud/aiplatform
      // Dynamic import — package is optional and may not be installed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiplatform: any = await import(AIPLATFORM_PKG).catch(() => null);
      if (!aiplatform) {
        throw new Error("@google-cloud/aiplatform is not installed — run: pnpm add @google-cloud/aiplatform");
      }

      const { PredictionServiceClient, helpers } = aiplatform;

      client = new PredictionServiceClient({
        apiEndpoint: `${this.config.gcpRegion}-aiplatform.googleapis.com`,
      });

      const endpoint = `projects/${this.config.gcpProjectId}/locations/${this.config.gcpRegion}/publishers/google/models/${this.config.imagenModel}`;

      // Build instance & parameters using SDK helpers for correct
      // protobuf Value encoding (avoids manual structValue wiring).
      const instanceValue = helpers.toValue({ prompt });

      const paramObj: Record<string, unknown> = {
        sampleCount: 1,
        aspectRatio,
      };
      if (options.negativePrompt) {
        paramObj.negativePrompt = options.negativePrompt;
      }
      // NOTE: Vertex AI Imagen rejects `seed` when watermarking is enabled
      // (the default). Omit seed for cloud provider — images are non-deterministic
      // unless the caller explicitly disables watermarks.
      const parametersValue = helpers.toValue(paramObj);

      logger.info(`[ImageGenService] Calling Vertex AI Imagen: project=${this.config.gcpProjectId}, region=${this.config.gcpRegion}, model=${this.config.imagenModel}, aspectRatio=${aspectRatio}`);

      // Retry with exponential backoff for RESOURCE_EXHAUSTED (quota) errors.
      // Imagen quota limits are per-minute; short backoffs allow recovery.
      const MAX_RETRIES = 3;
      let lastError: Error | null = null;
      let response: unknown = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [res] = await (client as any).predict({
            endpoint,
            instances: [instanceValue],
            parameters: parametersValue,
          });
          response = res;
          break;
        } catch (retryErr: unknown) {
          lastError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          const isQuota = lastError.message.includes("RESOURCE_EXHAUSTED");
          if (!isQuota || attempt === MAX_RETRIES) {
            throw lastError;
          }
          const backoffMs = 30_000 * Math.pow(2, attempt); // 30s, 60s, 120s
          logger.warn(`[ImageGenService] Quota exceeded — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }

      // Extract the base64-encoded image from the response.
      // predictions is an array of protobuf Values — convert back to JS.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPredictions = (response as any).predictions;
      if (!rawPredictions || rawPredictions.length === 0) {
        throw new Error("Imagen returned empty predictions");
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prediction = helpers.fromValue(rawPredictions[0] as any) as Record<string, unknown>;
      const imageB64 = prediction.bytesBase64Encoded as string | undefined;
      if (!imageB64) {
        logger.error(`[ImageGenService] Imagen prediction keys: ${Object.keys(prediction).join(", ")}`);
        throw new Error("Imagen response missing base64 image data");
      }

      const imageBuffer = Buffer.from(imageB64, "base64");
      const filePath = await this.saveImage(imageBuffer, "cloud");

      const elapsed = Date.now() - start;
      logger.info(`[ImageGenService] Cloud image generated in ${elapsed}ms (${aspectRatio})`);

      this._cloudAvailable = true;
      return { filePath, provider: "cloud", generationTimeMs: elapsed, width, height };
    } catch (error) {
      this._cloudAvailable = false;
      throw error;
    } finally {
      if (client?.close) {
        await client.close().catch(() => {
          // Non-fatal: client cleanup best-effort only.
        });
      }
    }
  }

  // ── Local Provider (Python Sidecar) ─────────────────────────

  private async generateLocal(
    prompt: string,
    width: number,
    height: number,
    options: ImageGenOptions,
  ): Promise<ImageGenResult> {
    // In network mode, use async submit + poll to avoid long-lived HTTP
    // connections that get ECONNRESET over the network.
    if (this.isNetworkMode) {
      return this.generateLocalAsync(prompt, width, height, options);
    }

    const start = Date.now();
    // Use controlnet endpoint if controlnet params are provided
    const isControlNet = !!options.controlnetImagePath;
    const url = `${this.effectiveSidecarUrl}/${isControlNet ? "generate-controlnet" : "generate"}`;

    try {
      // Normalize legacy "flux" alias to the sidecar's canonical model name
      const resolvedLocalModel = options.localModel === "flux" ? "flux-schnell" : options.localModel;
      const body = JSON.stringify({
        prompt,
        width,
        height,
        ...(resolvedLocalModel ? { model: resolvedLocalModel } : {}),
        ...(options.steps !== undefined ? { steps: options.steps } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
        ...(options.loraPaths ? { lora_paths: options.loraPaths } : {}),
        ...(options.loraScales ? { lora_scales: options.loraScales } : {}),
        ...(options.controlnetImagePath ? { controlnet_image_path: options.controlnetImagePath } : {}),
        ...(options.controlnetStrength !== undefined ? { controlnet_strength: options.controlnetStrength } : {}),
        ...(options.controlType ? { control_type: options.controlType } : {}),
      });

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.config.networkNodeToken) {
        headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.localTimeoutMs),
        dispatcher: this.longRunningDispatcher(),
      } as unknown as RequestInit);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(`Local sidecar returned ${response.status}: ${errorText}`);
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const filePath = await this.saveImage(imageBuffer, "local");

      const elapsed = Date.now() - start;
      const genTime = response.headers.get("X-Generation-Time") ?? `${elapsed}ms`;
      logger.info(`[ImageGenService] Local image generated in ${genTime} (${width}x${height})`);

      this._localAvailable = true;
      return { filePath, provider: "local", generationTimeMs: elapsed, width, height };
    } catch (error) {
      this._localAvailable = false;
      throw error;
    }
  }

  // ── Async Local Provider (submit + poll) ──────────────────────
  //
  // Used when imageGenMode === "network".  Submits to /generate-async
  // (returns 202 immediately), then polls GET /job-result/{job_id} until
  // the image is ready.  Avoids long-lived HTTP connections that get
  // ECONNRESET when the sidecar is on a remote machine.

  private async generateLocalAsync(
    prompt: string,
    width: number,
    height: number,
    options: ImageGenOptions,
  ): Promise<ImageGenResult> {
    const start = Date.now();
    const { nanoid } = await import("nanoid");
    const jobId = `director-${nanoid(12)}`;
    const url = `${this.effectiveSidecarUrl}/generate-async`;

    const resolvedLocalModel = options.localModel === "flux" ? "flux-schnell" : options.localModel;
    const body = JSON.stringify({
      job_id: jobId,
      // Send empty callback_url — we use polling, not callbacks.
      // An empty string satisfies older sidecar versions that require the field,
      // while the updated sidecar treats falsy values as poll-only.
      callback_url: "",
      prompt,
      width,
      height,
      ...(resolvedLocalModel ? { model: resolvedLocalModel } : {}),
      ...(options.steps !== undefined ? { steps: options.steps } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.networkNodeToken) {
      headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
    }

    // Submit async job — should return 202 immediately
    const submitResp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!submitResp.ok) {
      const errorText = await submitResp.text().catch(() => "unknown");
      throw new Error(`Async generate submit failed (${submitResp.status}): ${errorText}`);
    }

    logger.info(`[ImageGenService] Async job ${jobId} accepted — polling for result`);

    // Poll GET /job-result/{job_id} until the sidecar has the result
    const pollUrl = `${this.effectiveSidecarUrl}/job-result/${encodeURIComponent(jobId)}`;
    const pollHeaders: Record<string, string> = {};
    if (this.config.networkNodeToken) {
      pollHeaders["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
    }

    let pollIntervalMs = 3_000;             // start at 3s, with backoff
    const maxPollIntervalMs = 10_000;
    const deadline = start + this.config.localTimeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollIntervalMs));

      try {
        const pollResp = await fetch(pollUrl, {
          headers: pollHeaders,
          signal: AbortSignal.timeout(10_000),
        });

        if (pollResp.status === 404) {
          // Still processing
          continue;
        }

        if (!pollResp.ok) {
          const txt = await pollResp.text().catch(() => "unknown");
          throw new Error(`Poll failed (${pollResp.status}): ${txt}`);
        }

        const result = await pollResp.json() as {
          job_id: string;
          status: string;
          media_base64?: string;
          media_type?: string;
          error?: string;
          metadata?: Record<string, string>;
        };

        if (result.status === "failed") {
          this._localAvailable = false;
          throw new Error(`Async image generation failed: ${result.error ?? "unknown error"}`);
        }

        if (result.status === "complete" && result.media_base64) {
          const imageBuffer = Buffer.from(result.media_base64, "base64");
          const filePath = await this.saveImage(imageBuffer, "local");
          const elapsed = Date.now() - start;
          const genTime = result.metadata?.generation_time ?? `${elapsed}ms`;
          logger.info(
            `[ImageGenService] Async image generated in ${genTime} (${width}x${height}) — job ${jobId}`,
          );
          this._localAvailable = true;
          return { filePath, provider: "local", generationTimeMs: elapsed, width, height };
        }
      } catch (pollErr) {
        // Network hiccup during a single poll — retry unless deadline exceeded
        if (Date.now() >= deadline) throw pollErr;
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        logger.warn(`[ImageGenService] Poll for ${jobId} failed: ${msg} — retrying`);
      }

      pollIntervalMs = Math.min(Math.round(pollIntervalMs * 1.5), maxPollIntervalMs);
    }

    this._localAvailable = false;
    throw new Error(
      `Async image generation timed out after ${this.config.localTimeoutMs}ms — job ${jobId}`,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async saveImage(buffer: Buffer, provider: string): Promise<string> {
    const { nanoid } = await import("nanoid");
    const filename = `openzigs-${provider}-${nanoid(8)}.png`;
    const filePath = path.join(this.config.outputDir, filename);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  private resolveAspectRatio(width: number, height: number): string {
    const ratio = width / height;
    if (Math.abs(ratio - 16 / 9) < 0.1) return "16:9";
    if (Math.abs(ratio - 9 / 16) < 0.1) return "9:16";
    if (Math.abs(ratio - 4 / 3) < 0.1) return "4:3";
    if (Math.abs(ratio - 3 / 4) < 0.1) return "3:4";
    return "1:1";
  }

  private async checkCloudHealth(): Promise<boolean> {
    if (!this.config.gcpProjectId) {
      logger.debug("[ImageGenService] Cloud health: GCP_PROJECT_ID not set");
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiplatform: any = await import(AIPLATFORM_PKG).catch(() => null);
      if (!aiplatform) {
        logger.debug("[ImageGenService] Cloud health: @google-cloud/aiplatform not installed");
        this._cloudAvailable = false;
        return false;
      }
      const { PredictionServiceClient } = aiplatform;
      const client = new PredictionServiceClient({
        apiEndpoint: `${this.config.gcpRegion}-aiplatform.googleapis.com`,
      });
      // Verify the client can initialize (credential resolution happens here)
      void client;
      this._cloudAvailable = true;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[ImageGenService] Cloud health failed: ${msg}`);
      this._cloudAvailable = false;
      return false;
    }
  }

  /**
   * Enhance an existing image via img2img diffusion.
   * Reads the source image, sends it as base64 to the sidecar's /img2img endpoint,
   * and saves the enhanced result.
   *
   * This path is used by thumbnail enhancement; because Kontext and large models
   * may take many minutes to complete, the underlying fetch uses
   * ``localTimeoutMs`` which defaults to 20 minutes.
   *
   * @param imagePath - Path to the source image (PNG/JPEG/WebP)
   * @param prompt    - Enhancement prompt guiding the diffusion
   * @param options   - Strength (0.1–0.95), model, seed
   * @returns Result with the enhanced image file path
   */
  async enhanceImage(
    imagePath: string,
    prompt: string,
    options?: { strength?: number; model?: string; seed?: number; width?: number; height?: number; steps?: number; guidance_scale?: number },
  ): Promise<ImageGenResult> {
    const start = Date.now();
    const url = `${this.effectiveSidecarUrl}/img2img`;

    const imageBuffer = await fs.readFile(imagePath);
    const maxBytes = 20 * 1024 * 1024; // 20 MB limit
    if (imageBuffer.length > maxBytes) {
      throw new Error(`Image too large: ${imageBuffer.length} bytes (max ${maxBytes})`);
    }

    const base64Image = imageBuffer.toString("base64");
    const strength = Math.max(0.1, Math.min(0.95, options?.strength ?? 0.6));

    const body = JSON.stringify({
      prompt,
      image: base64Image,
      strength,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.seed !== undefined ? { seed: options.seed } : {}),
      ...(options?.width ? { width: options.width } : {}),
      ...(options?.height ? { height: options.height } : {}),
      ...(options?.steps ? { steps: options.steps } : {}),
      ...(options?.guidance_scale !== undefined ? { guidance_scale: options.guidance_scale } : {}),
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.networkNodeToken) {
      headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.localTimeoutMs),
      dispatcher: this.longRunningDispatcher(),
    } as unknown as RequestInit);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(`img2img sidecar returned ${response.status}: ${errorText}`);
    }

    const resultBuffer = Buffer.from(await response.arrayBuffer());
    const filePath = await this.saveImage(resultBuffer, "img2img");

    const elapsed = Date.now() - start;
    logger.info(`[ImageGenService] img2img enhancement in ${elapsed}ms (strength=${strength})`);

    return { filePath, provider: "local", generationTimeMs: elapsed, width: 0, height: 0 };
  }

  /**
   * Edit an image using FLUX.1 Kontext text-guided semantic editing.
   * Unlike img2img (which only restyles), Kontext can add, remove, or modify
   * objects in the scene based on natural language instructions.
   *
   * @param imagePath - Path to the source image (PNG/JPEG/WebP)
   * @param prompt    - Editing instruction (e.g. "Add a woman sitting on the hood")
   * @param options   - seed, width, height, steps, guidance
   * @returns Result with the edited image file path
   */
  async kontextEdit(
    imagePath: string,
    prompt: string,
    options?: { seed?: number; width?: number; height?: number; steps?: number; guidance?: number },
  ): Promise<ImageGenResult> {
    const start = Date.now();
    const url = `${this.effectiveSidecarUrl}/kontext`;

    const imageBuffer = await fs.readFile(imagePath);
    const maxBytes = 20 * 1024 * 1024;
    if (imageBuffer.length > maxBytes) {
      throw new Error(`Image too large: ${imageBuffer.length} bytes (max ${maxBytes})`);
    }

    const base64Image = imageBuffer.toString("base64");

    const body = JSON.stringify({
      prompt,
      image: base64Image,
      ...(options?.seed !== undefined ? { seed: options.seed } : {}),
      ...(options?.width ? { width: options.width } : {}),
      ...(options?.height ? { height: options.height } : {}),
      ...(options?.steps ? { steps: options.steps } : {}),
      ...(options?.guidance !== undefined ? { guidance: options.guidance } : {}),
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.networkNodeToken) {
      headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.localTimeoutMs),
      dispatcher: this.longRunningDispatcher(),
    } as unknown as RequestInit);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      // Try to parse JSON error detail from sidecar (FastAPI returns {"detail": "..."})
      let errorMessage = errorText;
      try {
        const parsed = JSON.parse(errorText);
        if (typeof parsed.detail === "string") {
          errorMessage = parsed.detail;
        } else if (typeof parsed.error === "string") {
          errorMessage = parsed.error;
        } else if (typeof parsed.message === "string") {
          errorMessage = parsed.message;
        }
      } catch {
        // Not JSON — use raw text
      }
      throw new Error(`Kontext sidecar returned ${response.status}: ${errorMessage}`);
    }

    const resultBuffer = Buffer.from(await response.arrayBuffer());

    if (resultBuffer.length < 8) {
      throw new Error(`Kontext sidecar returned empty or invalid response (${resultBuffer.length} bytes)`);
    }

    const filePath = await this.saveImage(resultBuffer, "kontext");

    const elapsed = Date.now() - start;
    logger.info(`[ImageGenService] Kontext edit in ${elapsed}ms`);

    // Read actual dimensions from PNG header if available, fall back to options
    const actualWidth = readPngWidth(resultBuffer) ?? options?.width ?? 0;
    const actualHeight = readPngHeight(resultBuffer) ?? options?.height ?? 0;

    return { filePath, provider: "local", generationTimeMs: elapsed, width: actualWidth, height: actualHeight };
  }

  private async checkLocalHealth(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.networkNodeToken) {
        headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
      }
      const response = await fetch(`${this.effectiveSidecarUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json() as { ready?: boolean };
      this._localAvailable = data.ready === true;
      return this._localAvailable;
    } catch {
      this._localAvailable = false;
      return false;
    }
  }
}

/**
 * Read width from a PNG file's IHDR chunk (bytes 16-19, big-endian uint32).
 * Returns null if the buffer is not a valid PNG.
 */
export function readPngWidth(buf: Buffer): number | null {
  // PNG signature (8 bytes) + IHDR length (4 bytes) + "IHDR" (4 bytes) + width (4 bytes) = need at least 24 bytes
  if (buf.length < 24) return null;
  // Check PNG signature: 0x89 P N G
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return buf.readUInt32BE(16);
}

/**
 * Read height from a PNG file's IHDR chunk (bytes 20-23, big-endian uint32).
 * Returns null if the buffer is not a valid PNG.
 */
export function readPngHeight(buf: Buffer): number | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return buf.readUInt32BE(20);
}
