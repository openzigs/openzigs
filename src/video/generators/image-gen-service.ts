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
}

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<ImageGenServiceConfig> = {
  gcpProjectId: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "",
  gcpRegion: process.env.GCP_REGION ?? "us-central1",
  imagenModel: "imagen-3.0-generate-001",
  localSidecarUrl: process.env.IMAGE_GEN_SIDECAR_URL ?? "http://127.0.0.1:5005",
  cloudTimeoutMs: 60_000,
  localTimeoutMs: 120_000,
  outputDir: path.join(os.tmpdir(), "openzigs-image-gen"),
};

// ── Service ───────────────────────────────────────────────────

export class ImageGenService {
  private readonly config: Required<ImageGenServiceConfig>;
  private _cloudAvailable: boolean | null = null;
  private _localAvailable: boolean | null = null;

  /** Whether the cloud provider is known to be available. */
  get cloudAvailable(): boolean | null { return this._cloudAvailable; }
  /** Whether the local sidecar is known to be available. */
  get localAvailable(): boolean | null { return this._localAvailable; }

  constructor(config?: ImageGenServiceConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

    try {
      // Use the Vertex AI REST prediction endpoint via @google-cloud/aiplatform
      // Dynamic import — package is optional and may not be installed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiplatform: any = await import(AIPLATFORM_PKG).catch(() => null);
      if (!aiplatform) {
        throw new Error("@google-cloud/aiplatform is not installed — run: pnpm add @google-cloud/aiplatform");
      }

      const { PredictionServiceClient } = aiplatform;

      const client = new PredictionServiceClient({
        apiEndpoint: `${this.config.gcpRegion}-aiplatform.googleapis.com`,
      });

      const endpoint = `projects/${this.config.gcpProjectId}/locations/${this.config.gcpRegion}/publishers/google/models/${this.config.imagenModel}`;

      // Build the prediction request following Imagen API spec
      const instance = {
        structValue: {
          fields: {
            prompt: { stringValue: prompt },
          },
        },
      };

      const parameters = {
        structValue: {
          fields: {
            sampleCount: { numberValue: 1 },
            aspectRatio: { stringValue: aspectRatio },
            ...(options.negativePrompt
              ? { negativePrompt: { stringValue: options.negativePrompt } }
              : {}),
            ...(options.seed !== undefined
              ? { seed: { numberValue: options.seed } }
              : {}),
          },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [response] = await (client as any).predict({
        endpoint,
        instances: [instance],
        parameters,
      });

      // Extract the base64-encoded image from the response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const predictions = (response as any).predictions;
      if (!predictions || predictions.length === 0) {
        throw new Error("Imagen returned empty predictions");
      }

      const imageB64 = predictions[0]?.structValue?.fields?.bytesBase64Encoded?.stringValue;
      if (!imageB64) {
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
    const url = `${this.config.localSidecarUrl}/generate`;

    try {
      const body = JSON.stringify({
        prompt,
        width,
        height,
        ...(options.steps !== undefined ? { steps: options.steps } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
      });

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    if (!this.config.gcpProjectId) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiplatform: any = await import(AIPLATFORM_PKG).catch(() => null);
      if (!aiplatform) {
        this._cloudAvailable = false;
        return false;
      }
      const { PredictionServiceClient } = aiplatform;
      const client = new PredictionServiceClient({
        apiEndpoint: `${this.config.gcpRegion}-aiplatform.googleapis.com`,
      });
      // Just check that the client can be instantiated
      void client;
      this._cloudAvailable = true;
      return true;
    } catch {
      this._cloudAvailable = false;
      return false;
    }
  }

  private async checkLocalHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.localSidecarUrl}/health`, {
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
