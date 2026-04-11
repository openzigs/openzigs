/**
 * Studio — AI Video Redundancy Analyzer
 * Issue #444: FFmpeg frame sampling + Vision LLM analysis.
 *
 * Extracts 1fps frames at thumbnail resolution, optionally transcribes audio,
 * then sends frames + transcript to a Vision LLM to detect redundant takes,
 * verbal stumbles, and dead space.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";

export interface SuggestedCut {
  start: number;
  end: number;
  reason: string;
}

export interface AnalyzeJob {
  id: string;
  inputPath: string;
  assetId: string;
  status:
    | "queued"
    | "extracting_frames"
    | "transcribing"
    | "analyzing"
    | "complete"
    | "failed";
  suggestedCuts: SuggestedCut[];
  error?: string;
  /** Model to use for vision analysis. */
  model?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface AnalyzeRequest {
  assetId: string;
  inputPath: string;
  /** Optional model override for vision analysis (passed through to Copilot SDK). */
  model?: string;
}

/** Attachment sent alongside a chat prompt (mirrors SdkAttachment from copilot-wrapper). */
export type AnalyzeAttachment = {
  type: "file";
  path: string;
  displayName?: string;
};

export interface AnalyzeWorkerOptions {
  /**
   * Chat function compatible with CopilotWrapper.chat() — sends a prompt with
   * optional file attachments and model override, returns an async generator of
   * response chunks. The Copilot SDK natively supports image file attachments
   * for vision-capable models.
   */
  chat: (
    prompt: string,
    options?: {
      attachments?: AnalyzeAttachment[];
      model?: string;
      tools?: never[];
    },
  ) => AsyncGenerator<string>;
  /** Audio sidecar URL for Whisper transcription (optional). */
  audioSidecarUrl?: string;
  /** Max frames to send per LLM batch (default: 60). */
  maxFramesPerBatch?: number;
}

const VISION_SYSTEM_PROMPT = `You are a video editor AI. You will receive:
1. A sequence of video frames (1 frame per second, numbered by timestamp)
2. An audio transcript with timestamps (if available)

Your job is to identify segments that should be CUT from the video:
- Repeated actions or sentences (the speaker said the same thing twice)
- Verbal stumbles, "um", "uh", long pauses, restarts
- Frozen or identical consecutive frames (dead screen)
- Technical issues (black frames, test patterns)
- Off-topic tangents or false starts

Return a JSON array of suggested cuts. Each cut has:
- "start": start time in seconds (integer)
- "end": end time in seconds (integer)  
- "reason": brief explanation (max 50 chars)

Return ONLY valid JSON. Example:
[
  {"start": 15, "end": 25, "reason": "Repeated previous sentence"},
  {"start": 42, "end": 48, "reason": "Long pause / dead space"}
]

If the video looks clean with no redundancy, return an empty array: []`;

export class AnalyzeWorker extends EventEmitter {
  private readonly queue: AnalyzeJob[] = [];
  private readonly jobs = new Map<string, AnalyzeJob>();
  private processing = false;
  private readonly chat: AnalyzeWorkerOptions["chat"];
  private readonly audioSidecarUrl?: string;
  private readonly maxFramesPerBatch: number;

  constructor(options: AnalyzeWorkerOptions) {
    super();
    this.chat = options.chat;
    this.audioSidecarUrl = options.audioSidecarUrl;
    this.maxFramesPerBatch = options.maxFramesPerBatch ?? 60;
  }

  async submit(request: AnalyzeRequest): Promise<string> {
    const id = `analyze-${nanoid(10)}`;
    const job: AnalyzeJob = {
      id,
      inputPath: request.inputPath,
      assetId: request.assetId,
      status: "queued",
      suggestedCuts: [],
      model: request.model,
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.queue.push(job);
    logger.info(
      `[AnalyzeWorker] Job ${id} queued: ${path.basename(request.inputPath)}`,
    );
    this.emit("analyze:queued", { jobId: id });
    this.processNext();
    return id;
  }

  getJob(id: string): AnalyzeJob | undefined {
    return this.jobs.get(id);
  }

  waitForCompletion(jobId: string, timeoutMs = 300_000): Promise<AnalyzeJob> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) return reject(new Error(`Job ${jobId} not found`));
      if (job.status === "complete") return resolve(job);
      if (job.status === "failed")
        return reject(new Error(job.error ?? "Analysis failed"));

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Analysis job ${jobId} timed out after ${timeoutMs}ms`),
        );
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
        this.removeListener("analyze:complete", onComplete);
        this.removeListener("analyze:failed", onFailed);
      };

      this.on("analyze:complete", onComplete);
      this.on("analyze:failed", onFailed);
    });
  }

  private processNext(): void {
    if (this.processing || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.processing = true;

    this.runAnalysis(job)
      .then(() => {
        job.status = "complete";
        job.completedAt = new Date();
        logger.info(
          `[AnalyzeWorker] Job ${job.id} complete: ${job.suggestedCuts.length} cuts found`,
        );
        this.emit("analyze:complete", {
          jobId: job.id,
          suggestedCuts: job.suggestedCuts,
        });
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeWorker] Job ${job.id} failed: ${job.error}`);
        this.emit("analyze:failed", { jobId: job.id, error: job.error });
      })
      .finally(() => {
        this.processing = false;
        this.processNext();
      });
  }

  private async runAnalysis(job: AnalyzeJob): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), `openzigs-analyze-${job.id}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Step 1: Extract frames (1fps, 320px)
      job.status = "extracting_frames";
      this.emit("analyze:progress", {
        jobId: job.id,
        stage: "extracting_frames",
        progress: 10,
      });
      const framePaths = await this.extractFrames(job.inputPath, tmpDir);

      // Step 2: Transcribe audio (optional)
      job.status = "transcribing";
      this.emit("analyze:progress", {
        jobId: job.id,
        stage: "transcribing",
        progress: 30,
      });
      let transcript = "";
      try {
        transcript = await this.transcribeAudio(job.inputPath, tmpDir);
      } catch {
        logger.warn(
          `[AnalyzeWorker] Transcription unavailable for job ${job.id}, proceeding with frames only`,
        );
      }

      // Step 3: Send to Vision LLM in batches
      job.status = "analyzing";
      this.emit("analyze:progress", {
        jobId: job.id,
        stage: "analyzing",
        progress: 50,
      });
      const allCuts: SuggestedCut[] = [];

      const batchCount = Math.ceil(framePaths.length / this.maxFramesPerBatch);
      for (let batch = 0; batch < batchCount; batch++) {
        const start = batch * this.maxFramesPerBatch;
        const batchFrames = framePaths.slice(
          start,
          start + this.maxFramesPerBatch,
        );
        const batchOffset = start; // Seconds offset for this batch

        const cuts = await this.analyzeFrameBatch(
          batchFrames,
          batchOffset,
          transcript,
          job.model,
        );
        allCuts.push(...cuts);

        const progress = 50 + Math.round(((batch + 1) / batchCount) * 45);
        this.emit("analyze:progress", {
          jobId: job.id,
          stage: "analyzing",
          progress,
        });
      }

      // Merge overlapping cuts
      job.suggestedCuts = this.mergeCuts(allCuts);
      this.emit("analyze:progress", {
        jobId: job.id,
        stage: "complete",
        progress: 100,
      });
    } finally {
      // Cleanup temp files
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        logger.warn(`[AnalyzeWorker] Failed to cleanup temp dir: ${tmpDir}`);
      }
    }
  }

  /** Extract 1 frame per second at 320px width using FFmpeg. */
  extractFrames(inputPath: string, outputDir: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const pattern = path.join(outputDir, "frame_%04d.jpg");
      const args = [
        "-i",
        inputPath,
        "-vf",
        "fps=1,scale=320:-2",
        "-q:v",
        "5",
        "-y",
        pattern,
      ];

      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      proc.on("close", (code) => {
        if (code !== 0)
          return reject(new Error(`Frame extraction failed: exit ${code}`));
        const files = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
          .sort()
          .map((f) => path.join(outputDir, f));
        resolve(files);
      });
      proc.on("error", (err) =>
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)),
      );
    });
  }

  /** Extract audio and transcribe via Whisper sidecar. */
  private async transcribeAudio(
    inputPath: string,
    tmpDir: string,
  ): Promise<string> {
    if (!this.audioSidecarUrl) {
      throw new Error("Audio sidecar not configured");
    }

    const wavPath = path.join(tmpDir, "audio.wav");

    // Extract audio as 16kHz mono WAV
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-i",
        inputPath,
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "-y",
        wavPath,
      ];
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      proc.on("close", (code) => {
        if (code !== 0)
          reject(new Error(`Audio extraction failed: exit ${code}`));
        else resolve();
      });
      proc.on("error", reject);
    });

    // Send to Whisper sidecar
    const wavData = fs.readFileSync(wavPath);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([wavData], { type: "audio/wav" }),
      "audio.wav",
    );
    formData.append("response_format", "verbose_json");

    const res = await fetch(`${this.audioSidecarUrl}/transcribe`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error(`Whisper transcription failed: ${res.status}`);
    const data = (await res.json()) as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    // Format with timestamps for the LLM
    if (data.segments?.length) {
      return data.segments
        .map(
          (s) =>
            `[${Math.round(s.start)}s-${Math.round(s.end)}s] ${s.text.trim()}`,
        )
        .join("\n");
    }
    return data.text ?? "";
  }

  /** Send a batch of frames + transcript to the Vision LLM via Copilot SDK file attachments. */
  private async analyzeFrameBatch(
    framePaths: string[],
    offsetSeconds: number,
    transcript: string,
    model?: string,
  ): Promise<SuggestedCut[]> {
    // Build file attachments — the Copilot SDK natively handles image files for vision models
    const attachments: AnalyzeAttachment[] = framePaths.map((fp, i) => ({
      type: "file" as const,
      path: fp,
      displayName: `Frame at ${offsetSeconds + i}s`,
    }));

    // Build the text prompt with transcript context and frame labels
    const transcriptSection = transcript
      ? `Audio Transcript:\n${transcript}\n\n`
      : "No audio transcript available.\n\n";

    const frameLabels = framePaths
      .map((_, i) => `  ${i + 1}. Frame at ${offsetSeconds + i}s`)
      .join("\n");

    const prompt = `${VISION_SYSTEM_PROMPT}\n\n${transcriptSection}Video frames attached (1 per second, starting at ${offsetSeconds}s):\n${frameLabels}\n\nAnalyze ALL attached frames and return the JSON array of suggested cuts.`;

    const chunks: string[] = [];
    for await (const chunk of this.chat(prompt, {
      attachments,
      model,
      tools: [],
    })) {
      chunks.push(chunk);
    }
    const response = chunks.join("");

    return this.parseLLMResponse(response);
  }

  /** Parse JSON array of suggested cuts from LLM response. */
  parseLLMResponse(raw: string): SuggestedCut[] {
    const jsonMatch = raw.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      return parsed
        .filter(
          (item): item is { start: number; end: number; reason: string } => {
            if (typeof item !== "object" || item === null) return false;
            const obj = item as Record<string, unknown>;
            return (
              typeof obj.start === "number" &&
              typeof obj.end === "number" &&
              typeof obj.reason === "string" &&
              obj.end > obj.start
            );
          },
        )
        .map(({ start, end, reason }) => ({
          start: Math.max(0, Math.round(start)),
          end: Math.max(0, Math.round(end)),
          reason: reason.slice(0, 100),
        }));
    } catch {
      logger.warn("[AnalyzeWorker] Failed to parse LLM response as JSON");
      return [];
    }
  }

  /** Merge overlapping or adjacent cuts. */
  private mergeCuts(cuts: SuggestedCut[]): SuggestedCut[] {
    if (cuts.length <= 1) return cuts;
    const sorted = [...cuts].sort((a, b) => a.start - b.start);
    const merged: SuggestedCut[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = sorted[i];
      // Merge if overlapping or within 2 seconds of each other
      if (cur.start <= prev.end + 2) {
        prev.end = Math.max(prev.end, cur.end);
        prev.reason =
          prev.reason.length > cur.reason.length ? prev.reason : cur.reason;
      } else {
        merged.push(cur);
      }
    }

    return merged;
  }
}
