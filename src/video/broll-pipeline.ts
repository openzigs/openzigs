/**
 * B-Roll Pipeline — AI-powered contextual B-Roll suggestion and insertion.
 * Issue #822: Auto B-Roll Insertion Pipeline.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import type { TranscriptSegment } from "./scene-graph.js";

export type BRollDensity = "sparse" | "moderate" | "dense";
export type TransitionStyle = "crossfade" | "cut" | "zoom" | "slide";
export type BRollSource = "stock" | "ai" | "library";

export interface BRollSuggestion {
  timestamp: number;
  duration: number;
  query: string;
  context: string;
  assetPath?: string;
  source: BRollSource;
  score: number;
}

export interface BRollJob {
  id: string;
  source: string;
  status:
    | "queued"
    | "transcribing"
    | "analyzing"
    | "searching"
    | "complete"
    | "failed";
  suggestions: BRollSuggestion[];
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface BRollRequest {
  source: string;
  mode: "auto" | "suggest" | "custom";
  sources?: BRollSource[];
  density?: BRollDensity;
  transitionStyle?: TransitionStyle;
  customAssets?: string[];
}

export type BRollChatFn = (
  prompt: string,
  options?: { tools?: never[] },
) => AsyncGenerator<string>;

export interface BRollPipelineOptions {
  chat: BRollChatFn;
  audioSidecarUrl?: string;
  searchStock?: (
    query: string,
  ) => Promise<Array<{ url: string; description: string }>>;
}

/** Density settings: seconds between B-Roll insertions. */
const DENSITY_INTERVALS: Record<BRollDensity, number> = {
  sparse: 120,
  moderate: 60,
  dense: 30,
};

const BROLL_ANALYSIS_PROMPT = `You are a professional video editor analyzing a transcript to identify B-Roll insertion points.

For each insertion point, provide:
- "timestamp": approximate seconds from start
- "duration": suggested B-Roll duration (3-8 seconds)
- "query": stock footage search query (specific, visual, 2-5 words)
- "context": why B-Roll would enhance this moment (max 80 chars)

RULES:
- Place B-Roll at moments of description, metaphor, or visual reference
- Avoid placing B-Roll during moments of direct address or personal stories
- Search queries should be visually specific (not abstract concepts)
- Space insertions at realistic intervals
- Return ONLY a valid JSON array`;

export class BRollPipeline extends EventEmitter {
  private readonly queue: BRollJob[] = [];
  private readonly jobs = new Map<string, BRollJob>();
  private processing = false;
  private readonly chat: BRollChatFn;
  private readonly audioSidecarUrl?: string;
  private readonly searchStock?: BRollPipelineOptions["searchStock"];

  constructor(options: BRollPipelineOptions) {
    super();
    this.chat = options.chat;
    this.audioSidecarUrl = options.audioSidecarUrl;
    this.searchStock = options.searchStock;
  }

  async submit(request: BRollRequest): Promise<string> {
    const id = `broll-${nanoid(10)}`;
    const job: BRollJob = {
      id,
      source: request.source,
      status: "queued",
      suggestions: [],
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.queue.push(job);
    logger.info(
      `[BRollPipeline] Job ${id} queued: ${path.basename(request.source)}`,
    );
    this.emit("broll:queued", { jobId: id });
    this.processNext(request);
    return id;
  }

  getJob(id: string): BRollJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): BRollJob[] {
    return [...this.jobs.values()];
  }

  waitForCompletion(jobId: string, timeoutMs = 300_000): Promise<BRollJob> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) return reject(new Error(`Job ${jobId} not found`));
      if (job.status === "complete") return resolve(job);
      if (job.status === "failed")
        return reject(new Error(job.error ?? "B-Roll pipeline failed"));

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`B-Roll job ${jobId} timed out`));
      }, timeoutMs);

      const onComplete = (data: { jobId: string }) => {
        if (data.jobId !== jobId) return;
        cleanup();
        resolve(this.jobs.get(jobId)!);
      };

      const onFailed = (data: { jobId: string; error: string }) => {
        if (data.jobId !== jobId) return;
        cleanup();
        reject(new Error(data.error));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("broll:complete", onComplete);
        this.removeListener("broll:failed", onFailed);
      };

      this.on("broll:complete", onComplete);
      this.on("broll:failed", onFailed);
    });
  }

  private processNext(request?: BRollRequest): void {
    if (this.processing || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.processing = true;

    const req = request ?? { source: job.source, mode: "suggest" as const };

    this.runPipeline(job, req)
      .then(() => {
        job.status = "complete";
        job.completedAt = new Date();
        logger.info(
          `[BRollPipeline] Job ${job.id} complete: ${job.suggestions.length} suggestions`,
        );
        this.emit("broll:complete", {
          jobId: job.id,
          suggestions: job.suggestions,
        });
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        logger.error(`[BRollPipeline] Job ${job.id} failed: ${job.error}`);
        this.emit("broll:failed", { jobId: job.id, error: job.error });
      })
      .finally(() => {
        this.processing = false;
        this.processNext();
      });
  }

  private async runPipeline(
    job: BRollJob,
    request: BRollRequest,
  ): Promise<void> {
    const density = request.density ?? "moderate";
    const interval = DENSITY_INTERVALS[density];

    // Step 1: Get transcript
    job.status = "transcribing";
    this.emit("broll:progress", {
      jobId: job.id,
      stage: "transcribing",
      progress: 10,
    });

    let transcript: TranscriptSegment[] = [];
    if (this.audioSidecarUrl) {
      transcript = await this.transcribeForBRoll(request.source);
    }

    // Step 2: LLM analysis for B-Roll opportunities
    job.status = "analyzing";
    this.emit("broll:progress", {
      jobId: job.id,
      stage: "analyzing",
      progress: 40,
    });

    const transcriptText = transcript
      .map((s) => `[${s.start.toFixed(1)}s] ${s.text}`)
      .join("\n");
    const prompt = `${BROLL_ANALYSIS_PROMPT}

Density: ${density} (insert approximately every ${interval} seconds)

Transcript:
${transcriptText || "(No transcript available — suggest generic B-Roll at regular intervals for a video of unknown content)"}`;

    let response = "";
    for await (const chunk of this.chat(prompt, { tools: [] })) {
      response += chunk;
    }

    let suggestions: BRollSuggestion[] = [];
    try {
      const parsed = JSON.parse(
        response
          .replace(/```json?\s*/g, "")
          .replace(/```\s*/g, "")
          .trim(),
      ) as Array<{
        timestamp?: number;
        duration?: number;
        query?: string;
        context?: string;
      }>;

      if (Array.isArray(parsed)) {
        suggestions = parsed
          .filter(
            (s) =>
              typeof s.timestamp === "number" && typeof s.query === "string",
          )
          .map((s) => ({
            timestamp: s.timestamp!,
            duration: Math.max(3, Math.min(8, s.duration ?? 5)),
            query: String(s.query).slice(0, 100),
            context: String(s.context ?? "").slice(0, 80),
            source: "stock" as BRollSource,
            score: 0.5,
          }));
      }
    } catch {
      logger.warn("[BRollPipeline] Failed to parse B-Roll analysis response");
    }

    // Step 3: Search stock footage for each suggestion
    if (this.searchStock && suggestions.length > 0) {
      job.status = "searching";
      this.emit("broll:progress", {
        jobId: job.id,
        stage: "searching",
        progress: 70,
      });

      for (const suggestion of suggestions) {
        try {
          const results = await this.searchStock(suggestion.query);
          if (results.length > 0) {
            suggestion.assetPath = results[0].url;
            suggestion.score = 0.8;
          }
        } catch {
          // Search failure is non-fatal
        }
      }
    }

    job.suggestions = suggestions;
    this.emit("broll:progress", {
      jobId: job.id,
      stage: "complete",
      progress: 100,
    });
  }

  /** Transcribe audio for B-Roll analysis. */
  private async transcribeForBRoll(
    source: string,
  ): Promise<TranscriptSegment[]> {
    if (!this.audioSidecarUrl) return [];

    const tmpDir = path.join(os.tmpdir(), `openzigs-broll-${nanoid(6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Extract audio
      const audioPath = path.join(tmpDir, "audio.wav");
      const { spawn } = await import("node:child_process");

      await new Promise<void>((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-i",
          source,
          "-vn",
          "-acodec",
          "pcm_s16le",
          "-ar",
          "16000",
          "-ac",
          "1",
          audioPath,
          "-y",
        ]);
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error("Audio extraction failed")),
        );
        proc.on("error", reject);
      });

      const audioBuffer = fs.readFileSync(audioPath);
      const formData = new FormData();
      formData.append("audio", new Blob([audioBuffer]), "audio.wav");

      const response = await fetch(`${this.audioSidecarUrl}/whisper`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) return [];

      const result = (await response.json()) as {
        segments?: Array<{ text: string; start: number; end: number }>;
      };

      return (result.segments ?? []).map((seg) => ({
        text: seg.text,
        start: seg.start,
        end: seg.end,
        words: [],
      }));
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }
}
