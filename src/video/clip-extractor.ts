/**
 * Clip Extractor — Orchestrates multi-modal AI clip extraction.
 * Issue #821: Transcribe → sample frames → Vision LLM describe →
 *             build scene graph → LLM score segments → extract clips.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import {
  buildSceneGraph,
  type SceneGraph,
  type TranscriptSegment,
  type VisualFrame,
  type SceneChange,
} from "./scene-graph.js";

export interface ExtractedClip {
  startTime: number;
  endTime: number;
  viralityScore: number;
  title: string;
  description: string;
  hookDetected: boolean;
}

export interface ClipExtractionJob {
  id: string;
  source: string;
  status:
    | "queued"
    | "transcribing"
    | "sampling_frames"
    | "analyzing"
    | "scoring"
    | "extracting"
    | "complete"
    | "failed";
  clips: ExtractedClip[];
  sceneGraph?: SceneGraph;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface ClipExtractionRequest {
  source: string;
  prompt?: string;
  mode: "auto" | "prompt";
  clipCount?: number;
  duration?: { min: number; max: number };
  style?: "react" | "highlight" | "summarize" | "teaser";
}

export type ClipExtractorChatFn = (
  prompt: string,
  options?: {
    attachments?: Array<{ type: "file"; path: string; displayName?: string }>;
    model?: string;
    tools?: never[];
  },
) => AsyncGenerator<string>;

export interface ClipExtractorOptions {
  chat: ClipExtractorChatFn;
  audioSidecarUrl?: string;
  maxFramesPerBatch?: number;
}

const CLIP_SCORING_PROMPT = `You are a viral content expert. Analyze these video segments and identify the best clips.

For each clip, provide:
- startTime: seconds (number)
- endTime: seconds (number)
- viralityScore: 0-100 score
- title: catchy clip title (max 60 chars)
- description: why this clip works (max 120 chars)
- hookDetected: boolean (does the clip start with a strong hook?)

STYLE GUIDE:
- "react": emotional reactions, surprising moments, jaw-drop reactions
- "highlight": key takeaways, important information, quotable moments
- "summarize": condensed overview, main points, TLDR
- "teaser": curiosity-building, cliffhangers, teasers that make you want more

RULES:
- Each clip must be a coherent, standalone piece of content
- Minimum 15 seconds, maximum 90 seconds
- Prefer clips that start with a hook (question, bold statement, action)
- Higher scores for emotional peaks, visual variety, and clear value
- Return ONLY valid JSON array`;

export class ClipExtractor extends EventEmitter {
  private readonly queue: ClipExtractionJob[] = [];
  private readonly jobs = new Map<string, ClipExtractionJob>();
  private processing = false;
  private readonly chat: ClipExtractorChatFn;
  private readonly audioSidecarUrl?: string;
  private readonly maxFramesPerBatch: number;

  constructor(options: ClipExtractorOptions) {
    super();
    this.chat = options.chat;
    this.audioSidecarUrl = options.audioSidecarUrl;
    this.maxFramesPerBatch = options.maxFramesPerBatch ?? 60;
  }

  async submit(request: ClipExtractionRequest): Promise<string> {
    const id = `clip-${nanoid(10)}`;
    const job: ClipExtractionJob = {
      id,
      source: request.source,
      status: "queued",
      clips: [],
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.queue.push(job);
    logger.info(
      `[ClipExtractor] Job ${id} queued: ${path.basename(request.source)}`,
    );
    this.emit("clip:queued", { jobId: id });
    this.processNext(request);
    return id;
  }

  getJob(id: string): ClipExtractionJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ClipExtractionJob[] {
    return [...this.jobs.values()];
  }

  waitForCompletion(
    jobId: string,
    timeoutMs = 600_000,
  ): Promise<ClipExtractionJob> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) return reject(new Error(`Job ${jobId} not found`));
      if (job.status === "complete") return resolve(job);
      if (job.status === "failed")
        return reject(new Error(job.error ?? "Clip extraction failed"));

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Clip extraction ${jobId} timed out after ${timeoutMs}ms`),
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
        this.removeListener("clip:complete", onComplete);
        this.removeListener("clip:failed", onFailed);
      };

      this.on("clip:complete", onComplete);
      this.on("clip:failed", onFailed);
    });
  }

  private processNext(request?: ClipExtractionRequest): void {
    if (this.processing || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.processing = true;

    const req = request ?? {
      source: job.source,
      mode: "auto" as const,
    };

    this.runExtraction(job, req)
      .then(() => {
        job.status = "complete";
        job.completedAt = new Date();
        logger.info(
          `[ClipExtractor] Job ${job.id} complete: ${job.clips.length} clips found`,
        );
        this.emit("clip:complete", {
          jobId: job.id,
          clips: job.clips,
        });
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        logger.error(`[ClipExtractor] Job ${job.id} failed: ${job.error}`);
        this.emit("clip:failed", { jobId: job.id, error: job.error });
      })
      .finally(() => {
        this.processing = false;
        this.processNext();
      });
  }

  private async runExtraction(
    job: ClipExtractionJob,
    request: ClipExtractionRequest,
  ): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), `openzigs-clip-${job.id}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Step 1: Transcribe
      job.status = "transcribing";
      this.emit("clip:progress", {
        jobId: job.id,
        stage: "transcribing",
        progress: 10,
      });
      let transcript: TranscriptSegment[] = [];
      try {
        transcript = await this.transcribeAudio(request.source, tmpDir);
      } catch {
        logger.warn(`[ClipExtractor] Transcription unavailable for ${job.id}`);
      }

      // Step 2: Sample frames
      job.status = "sampling_frames";
      this.emit("clip:progress", {
        jobId: job.id,
        stage: "sampling_frames",
        progress: 25,
      });
      const framePaths = await this.extractFrames(request.source, tmpDir);

      // Step 3: Detect scene changes
      const sceneChanges = await this.detectSceneChanges(request.source);

      // Step 4: Vision LLM analysis
      job.status = "analyzing";
      this.emit("clip:progress", {
        jobId: job.id,
        stage: "analyzing",
        progress: 40,
      });
      const frames = await this.analyzeFrames(framePaths, tmpDir);

      // Step 5: Build scene graph
      const duration = await this.getVideoDuration(request.source);
      const sceneGraph = buildSceneGraph({
        duration,
        transcript,
        frames,
        sceneChanges,
      });
      job.sceneGraph = sceneGraph;

      // Step 6: LLM scoring
      job.status = "scoring";
      this.emit("clip:progress", {
        jobId: job.id,
        stage: "scoring",
        progress: 70,
      });
      const clips = await this.scoreAndExtractClips(sceneGraph, request);

      job.clips = clips;
      this.emit("clip:progress", {
        jobId: job.id,
        stage: "complete",
        progress: 100,
      });
    } finally {
      // Cleanup temp dir
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /** Extract frames at 1fps for vision analysis. */
  async extractFrames(inputPath: string, tmpDir: string): Promise<string[]> {
    const framePattern = path.join(tmpDir, "frame_%04d.jpg");
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-vf",
        "fps=1,scale=320:-1",
        "-q:v",
        "5",
        framePattern,
        "-y",
      ]);

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `FFmpeg frame extraction failed (code ${code}): ${stderr.slice(-500)}`,
            ),
          );
          return;
        }
        const files = fs
          .readdirSync(tmpDir)
          .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
          .sort()
          .map((f) => path.join(tmpDir, f));
        resolve(files);
      });

      proc.on("error", reject);
    });
  }

  /** Detect scene changes using FFmpeg scdet filter. */
  async detectSceneChanges(inputPath: string): Promise<SceneChange[]> {
    return new Promise((resolve) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-vf",
        "select='gt(scene,0.3)',showinfo",
        "-f",
        "null",
        "-",
      ]);

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", () => {
        const changes: SceneChange[] = [];
        const lines = stderr.split("\n");
        for (const line of lines) {
          const ptsMatch = line.match(/pts_time:(\d+\.?\d*)/);
          const sceneMatch = line.match(/scene:(\d+\.?\d*)/);
          if (ptsMatch) {
            changes.push({
              timestamp: parseFloat(ptsMatch[1]),
              score: sceneMatch ? parseFloat(sceneMatch[1]) : 0.5,
            });
          }
        }
        resolve(changes);
      });

      proc.on("error", () => resolve([]));
    });
  }

  /** Get video duration via ffprobe. */
  async getVideoDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffprobe", [
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputPath,
      ]);

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("ffprobe failed"));
          return;
        }
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 0 : duration);
      });

      proc.on("error", reject);
    });
  }

  /** Transcribe audio using Whisper sidecar. */
  private async transcribeAudio(
    inputPath: string,
    tmpDir: string,
  ): Promise<TranscriptSegment[]> {
    if (!this.audioSidecarUrl) {
      return [];
    }

    // Extract audio track
    const audioPath = path.join(tmpDir, "audio.wav");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
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

    // Send to Whisper sidecar
    const audioBuffer = fs.readFileSync(audioPath);
    const formData = new FormData();
    formData.append("audio", new Blob([audioBuffer]), "audio.wav");

    const response = await fetch(`${this.audioSidecarUrl}/whisper`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper sidecar returned ${response.status}`);
    }

    const result = (await response.json()) as {
      segments?: Array<{
        text: string;
        start: number;
        end: number;
        words?: Array<{
          word: string;
          start: number;
          end: number;
          probability: number;
        }>;
      }>;
    };

    return (result.segments ?? []).map((seg) => ({
      text: seg.text,
      start: seg.start,
      end: seg.end,
      words: (seg.words ?? []).map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.probability,
      })),
    }));
  }

  /** Analyze frames with Vision LLM. */
  private async analyzeFrames(
    framePaths: string[],
    _tmpDir: string,
  ): Promise<VisualFrame[]> {
    const frames: VisualFrame[] = [];

    // Process in batches
    for (let i = 0; i < framePaths.length; i += this.maxFramesPerBatch) {
      const batch = framePaths.slice(i, i + this.maxFramesPerBatch);
      const attachments = batch.map((p) => ({
        type: "file" as const,
        path: p,
        displayName: path.basename(p),
      }));

      const prompt = `Analyze these ${batch.length} video frames (1 per second, starting at timestamp ${i}s).
For each frame, return a JSON array entry:
{
  "timestamp": number (seconds from start),
  "description": "brief description",
  "subjects": ["person", "object", ...],
  "onScreenText": ["text visible on screen"],
  "sceneType": "talking-head" | "b-roll" | "screenshare" | "action" | "title-card" | "other",
  "emotionalTone": "neutral" | "excited" | "surprised" | "passionate" | "funny" | "serious" | "sad"
}
Return ONLY a valid JSON array.`;

      let response = "";
      try {
        for await (const chunk of this.chat(prompt, {
          attachments,
          tools: [],
        })) {
          response += chunk;
        }

        const parsed = JSON.parse(
          response
            .replace(/```json?\s*/g, "")
            .replace(/```\s*/g, "")
            .trim(),
        ) as VisualFrame[];

        if (Array.isArray(parsed)) {
          for (const frame of parsed) {
            frames.push({
              timestamp: frame.timestamp ?? i + frames.length,
              description: frame.description ?? "",
              subjects: Array.isArray(frame.subjects) ? frame.subjects : [],
              onScreenText: Array.isArray(frame.onScreenText)
                ? frame.onScreenText
                : [],
              sceneType: frame.sceneType ?? "other",
              emotionalTone: frame.emotionalTone ?? "neutral",
            });
          }
        }
      } catch {
        logger.warn(
          `[ClipExtractor] Failed to parse frame analysis batch at ${i}s`,
        );
      }
    }

    return frames;
  }

  /** Score segments and determine optimal clip boundaries. */
  private async scoreAndExtractClips(
    sceneGraph: SceneGraph,
    request: ClipExtractionRequest,
  ): Promise<ExtractedClip[]> {
    const clipCount = request.clipCount ?? 10;
    const minDuration = request.duration?.min ?? 15;
    const maxDuration = request.duration?.max ?? 90;
    const style = request.style ?? "highlight";

    const segmentSummary = sceneGraph.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      transcript: seg.transcript.slice(0, 200),
      emotionalTone: seg.emotionalTone,
      sceneType: seg.sceneType,
      hookStrength: seg.hookStrength,
      subjects: seg.subjects.slice(0, 5),
    }));

    const promptText = request.prompt
      ? `User request: "${request.prompt}"\n\n`
      : "";

    const scoringPrompt = `${CLIP_SCORING_PROMPT}

${promptText}Style: "${style}"
Target clip count: ${clipCount}
Duration range: ${minDuration}-${maxDuration} seconds
Total video duration: ${sceneGraph.duration} seconds

Video scene graph segments:
${JSON.stringify(segmentSummary, null, 2)}

Return a JSON array of the top ${clipCount} clips. Each clip:
${JSON.stringify([{ startTime: 0, endTime: 0, viralityScore: 0, title: "", description: "", hookDetected: false }])}`;

    let response = "";
    for await (const chunk of this.chat(scoringPrompt, { tools: [] })) {
      response += chunk;
    }

    try {
      const parsed = JSON.parse(
        response
          .replace(/```json?\s*/g, "")
          .replace(/```\s*/g, "")
          .trim(),
      ) as ExtractedClip[];

      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (clip) =>
            typeof clip.startTime === "number" &&
            typeof clip.endTime === "number" &&
            clip.endTime > clip.startTime &&
            clip.endTime - clip.startTime >= minDuration &&
            clip.endTime - clip.startTime <= maxDuration &&
            clip.endTime <= sceneGraph.duration,
        )
        .map((clip) => ({
          startTime: clip.startTime,
          endTime: clip.endTime,
          viralityScore: Math.min(100, Math.max(0, clip.viralityScore ?? 50)),
          title: String(clip.title ?? "Untitled Clip").slice(0, 60),
          description: String(clip.description ?? "").slice(0, 120),
          hookDetected: Boolean(clip.hookDetected),
        }))
        .sort((a, b) => b.viralityScore - a.viralityScore)
        .slice(0, clipCount);
    } catch {
      logger.warn("[ClipExtractor] Failed to parse clip scoring response");
      return [];
    }
  }
}
