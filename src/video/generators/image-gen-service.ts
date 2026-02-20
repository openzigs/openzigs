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
import { logger } from "../../logging/logger.js";

// Optional dependency — loaded dynamically at runtime to avoid hard compile-time requirement.
// Bypass TS static module resolution by constructing the specifier at runtime.
const AIPLATFORM_PKG = ["@google-cloud", "aiplatform"].join("/");

// ── Types ─────────────────────────────────────────────────────

export type ImageProvider = "cloud" | "local" | "auto";

export interface ImageGenOptions {
  /** Which provider to use (default: "auto" — try cloud, fallback to local) */
  provider?: ImageProvider;
  /** Which local sidecar model to use (e.g. "flux", "sdxl-turbo"). Ignored for cloud provider. */
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
  /** Timeout for local requests in ms (default: 120000) */
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
    localTimeoutMs: 120_000,
    outputDir: path.join(os.tmpdir(), "openzigs-image-gen"),
    imageGenMode: (process.env.IMAGE_GEN_MODE as "local" | "network" | undefined) ?? "local",
    networkNodeUrl: process.env.IMAGE_GEN_NETWORK_URL ?? "",
    networkNodeToken: process.env.IMAGE_GEN_NETWORK_TOKEN ?? "",
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

    // Auto mode: try cloud first, failover to local
    try {
      return await this.generateCloud(prompt, width, height, options);
    } catch (cloudError) {
      const msg = cloudError instanceof Error ? cloudError.message : String(cloudError);
      logger.warn(`[ImageGenService] Cloud generation failed: ${msg} — falling back to local sidecar`);

      try {
        return await this.generateLocal(prompt, width, height, options);
      } catch (localError) {
        const localMsg = localError instanceof Error ? localError.message : String(localError);
        throw new Error(
          `Image generation failed on both providers. Cloud: ${msg}. Local: ${localMsg}`,
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
      if (this.isNetworkMode && this.config.networkNodeToken) {
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
    const start = Date.now();
    const url = `${this.effectiveSidecarUrl}/generate`;

    try {
      const body = JSON.stringify({
        prompt,
        width,
        height,
        ...(options.localModel ? { model: options.localModel } : {}),
        ...(options.steps !== undefined ? { steps: options.steps } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
      });

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.isNetworkMode && this.config.networkNodeToken) {
        headers["Authorization"] = `Bearer ${this.config.networkNodeToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.localTimeoutMs),
      });

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

  private async checkLocalHealth(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.isNetworkMode && this.config.networkNodeToken) {
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
