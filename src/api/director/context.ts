/**
 * Shared context object threaded through every Director sub-router.
 *
 * Captures the closure state and helper functions that the original
 * monolithic `createDirectorRouter` held inside its lexical scope:
 *   - `runtimeConfig` (mutable, edited by PUT /config)
 *   - `produceJobs` / `thumbnailJobs` (in-memory job trackers)
 *   - `assetManagerInstance` (lazy singleton, reset on config change)
 *   - `getAssetManager`, `probeAudioDurationSeconds`, `probeVideoInfo`,
 *     `ensureGalleryTables` (helpers)
 *
 * The context is created once per `createDirectorRouter()` invocation
 * and passed by reference into each sub-router registration function.
 */

import { spawn } from "node:child_process";
import type { Server as SocketIOServer } from "socket.io";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type { VoiceService } from "../../voice/voice-service.js";
import type { RenderOrchestrator } from "../../video/render-orchestrator.js";
import type { BrandVoiceService } from "../../personality/brand-voice-service.js";
import type { ToolRegistry } from "../../mcp/tool-registry.js";
import type { AssetManager } from "../../video/assets/asset-manager.js";

export interface DirectorRuntimeConfig {
  pixabayApiKey: string;
  jamendoClientId: string;
  pexelsApiKey: string;
  /** Empty string means "use system default". */
  defaultModel: string;
}

export interface ProduceJob {
  id: string;
  status: "running" | "complete" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  completedAt?: number;
  abort?: AbortController;
}

export interface ThumbnailJob {
  id: string;
  draftId: string;
  status: "running" | "complete" | "failed";
  result?: {
    thumbnailUrl: string;
    suggestedText: string[];
    selectedFrame: { timestamp: number; rationale: string };
    mode: string;
  };
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface DirectorContextConfig {
  enabled: boolean;
  outputDir: string;
  defaultTemplate: string;
  assets: {
    localLibraryPath: string;
    downloadCachePath: string;
    pixabayApiKey: string;
    jamendoClientId: string;
    pexelsApiKey: string;
  };
}

export interface DirectorContextOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
  renderOrchestrator?: RenderOrchestrator;
  brandVoiceService?: BrandVoiceService;
  toolRegistry?: ToolRegistry;
  config: DirectorContextConfig;
}

export interface DirectorContext {
  readonly copilot: CopilotWrapper;
  readonly voiceService?: VoiceService;
  readonly renderOrchestrator?: RenderOrchestrator;
  readonly brandVoiceService?: BrandVoiceService;
  readonly toolRegistry?: ToolRegistry;
  readonly config: DirectorContextConfig;
  readonly runtimeConfig: DirectorRuntimeConfig;
  readonly produceJobs: Map<string, ProduceJob>;
  readonly thumbnailJobs: Map<string, ThumbnailJob>;
  /** Lazily instantiate (and cache) the asset manager. */
  getAssetManager(): Promise<AssetManager>;
  /** Drop the cached asset manager (called from PUT /config). */
  resetAssetManager(): void;
  probeAudioDurationSeconds(filePath: string): Promise<number | null>;
  probeVideoInfo(
    filePath: string,
  ): Promise<{ durationSec: number; width: number; height: number } | null>;
  ensureGalleryTables(db: import("better-sqlite3").Database): void;
  /** Returns the late-bound Socket.IO server, or null if not wired yet. */
  io(): SocketIOServer | null;
}

/** Late-bound Socket.IO reference, populated by setDirectorIO(). */
let _io: SocketIOServer | null = null;
export function setDirectorIO(io: SocketIOServer): void {
  _io = io;
}
export function getDirectorIO(): SocketIOServer | null {
  return _io;
}

export function createDirectorContext(
  opts: DirectorContextOptions,
): DirectorContext {
  const runtimeConfig: DirectorRuntimeConfig = {
    pixabayApiKey: opts.config.assets.pixabayApiKey,
    jamendoClientId: opts.config.assets.jamendoClientId,
    pexelsApiKey: opts.config.assets.pexelsApiKey,
    defaultModel: "",
  };

  const produceJobs = new Map<string, ProduceJob>();
  const thumbnailJobs = new Map<string, ThumbnailJob>();

  let assetManagerInstance: AssetManager | null = null;
  let galleryTablesReady = false;

  async function getAssetManager(): Promise<AssetManager> {
    if (!assetManagerInstance) {
      const { AssetManager } =
        await import("../../video/assets/asset-manager.js");
      assetManagerInstance = new AssetManager({
        localLibraryPath: opts.config.assets.localLibraryPath,
        downloadCachePath: opts.config.assets.downloadCachePath,
        pixabay: {
          enabled:
            !!runtimeConfig.pixabayApiKey &&
            !runtimeConfig.pixabayApiKey.startsWith("${"),
          apiKey: runtimeConfig.pixabayApiKey,
        },
        jamendo: {
          enabled:
            !!runtimeConfig.jamendoClientId &&
            !runtimeConfig.jamendoClientId.startsWith("${"),
          clientId: runtimeConfig.jamendoClientId,
        },
        pexels: {
          enabled:
            !!runtimeConfig.pexelsApiKey &&
            !runtimeConfig.pexelsApiKey.startsWith("${"),
          apiKey: runtimeConfig.pexelsApiKey,
        },
      });
      await assetManagerInstance.initialize();
    }
    return assetManagerInstance;
  }

  function resetAssetManager(): void {
    assetManagerInstance = null;
  }

  async function probeAudioDurationSeconds(
    filePath: string,
  ): Promise<number | null> {
    return await new Promise<number | null>((resolve) => {
      const proc = spawn("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ]);

      let stdout = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      proc.on("error", () => {
        resolve(null);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const duration = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) {
          resolve(null);
          return;
        }
        resolve(duration);
      });
    });
  }

  async function probeVideoInfo(
    filePath: string,
  ): Promise<{ durationSec: number; width: number; height: number } | null> {
    return await new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        filePath,
      ]);

      let stdout = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      proc.on("error", () => {
        resolve(null);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const stream = data.streams?.[0];
          const durationSec = Number.parseFloat(data.format?.duration);
          if (!Number.isFinite(durationSec) || durationSec <= 0) {
            resolve(null);
            return;
          }
          resolve({
            durationSec,
            width: stream?.width ?? 0,
            height: stream?.height ?? 0,
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  function ensureGalleryTables(db: import("better-sqlite3").Database): void {
    if (galleryTablesReady) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gallery_collection_items (
        collection_id TEXT NOT NULL,
        asset_path TEXT NOT NULL,
        PRIMARY KEY (collection_id, asset_path),
        FOREIGN KEY (collection_id) REFERENCES gallery_collections(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS gallery_tags (
        asset_path TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (asset_path, tag)
      );
    `);
    galleryTablesReady = true;
  }

  return {
    copilot: opts.copilot,
    voiceService: opts.voiceService,
    renderOrchestrator: opts.renderOrchestrator,
    brandVoiceService: opts.brandVoiceService,
    toolRegistry: opts.toolRegistry,
    config: opts.config,
    runtimeConfig,
    produceJobs,
    thumbnailJobs,
    getAssetManager,
    resetAssetManager,
    probeAudioDurationSeconds,
    probeVideoInfo,
    ensureGalleryTables,
    io: getDirectorIO,
  };
}
