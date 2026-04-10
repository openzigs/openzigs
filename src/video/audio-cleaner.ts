/**
 * Audio Cleaner — Filler word detection, silence trimming, and audio enhancement.
 * Issue #820: Filler Word & Pause Removal.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";

export type AggressivenessLevel = "gentle" | "moderate" | "aggressive";

export interface FillerDetection {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface SilenceRegion {
  start: number;
  end: number;
  duration: number;
}

export interface AudioCleanJob {
  id: string;
  source: string;
  status:
    | "queued"
    | "transcribing"
    | "detecting"
    | "cleaning"
    | "enhancing"
    | "complete"
    | "failed";
  outputPath?: string;
  removedFillers: number;
  silenceTrimmed: number;
  durationSaved: number;
  fillerDetections: FillerDetection[];
  silenceRegions: SilenceRegion[];
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface AudioCleanRequest {
  source: string;
  removeFiller?: boolean;
  fillerWords?: string[];
  trimSilence?: boolean;
  maxSilenceDuration?: number;
  aggressiveness?: AggressivenessLevel;
  enhanceSpeech?: boolean;
  deNoise?: boolean;
  outputPath?: string;
}

export interface AudioCleanerOptions {
  audioSidecarUrl?: string;
}

export const DEFAULT_FILLER_WORDS: Record<AggressivenessLevel, string[]> = {
  gentle: ["um", "uh", "er", "ah"],
  moderate: [
    "um",
    "uh",
    "er",
    "ah",
    "like",
    "you know",
    "I mean",
    "sort of",
    "kind of",
    "basically",
    "actually",
    "literally",
  ],
  aggressive: [
    "um",
    "uh",
    "er",
    "ah",
    "like",
    "you know",
    "I mean",
    "sort of",
    "kind of",
    "basically",
    "actually",
    "literally",
    "right",
    "so",
    "well",
    "okay",
    "just",
  ],
};

export class AudioCleaner extends EventEmitter {
  private readonly queue: AudioCleanJob[] = [];
  private readonly jobs = new Map<string, AudioCleanJob>();
  private processing = false;
  private readonly audioSidecarUrl?: string;

  constructor(options: AudioCleanerOptions = {}) {
    super();
    this.audioSidecarUrl = options.audioSidecarUrl;
  }

  async submit(request: AudioCleanRequest): Promise<string> {
    const id = `clean-${nanoid(10)}`;
    const galleryDir = path.join(os.homedir(), ".openzigs", "gallery");
    fs.mkdirSync(galleryDir, { recursive: true });

    const ext = path.extname(request.source);
    const baseName = path.basename(request.source, ext);
    const outputPath =
      request.outputPath ??
      path.join(galleryDir, `${baseName}_cleaned_${Date.now()}${ext}`);

    const job: AudioCleanJob = {
      id,
      source: request.source,
      status: "queued",
      outputPath,
      removedFillers: 0,
      silenceTrimmed: 0,
      durationSaved: 0,
      fillerDetections: [],
      silenceRegions: [],
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.queue.push(job);
    logger.info(
      `[AudioCleaner] Job ${id} queued: ${path.basename(request.source)}`,
    );
    this.emit("clean:queued", { jobId: id });
    this.processNext(request);
    return id;
  }

  getJob(id: string): AudioCleanJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): AudioCleanJob[] {
    return [...this.jobs.values()];
  }

  waitForCompletion(
    jobId: string,
    timeoutMs = 300_000,
  ): Promise<AudioCleanJob> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) return reject(new Error(`Job ${jobId} not found`));
      if (job.status === "complete") return resolve(job);
      if (job.status === "failed")
        return reject(new Error(job.error ?? "Audio cleaning failed"));

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Audio clean ${jobId} timed out`));
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
        this.removeListener("clean:complete", onComplete);
        this.removeListener("clean:failed", onFailed);
      };

      this.on("clean:complete", onComplete);
      this.on("clean:failed", onFailed);
    });
  }

  private processNext(request?: AudioCleanRequest): void {
    if (this.processing || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.processing = true;

    const req = request ?? { source: job.source };

    this.runCleaning(job, req)
      .then(() => {
        job.status = "complete";
        job.completedAt = new Date();
        logger.info(
          `[AudioCleaner] Job ${job.id} complete: ${job.removedFillers} fillers, ${job.silenceTrimmed} silence regions, ${job.durationSaved.toFixed(1)}s saved`,
        );
        this.emit("clean:complete", {
          jobId: job.id,
          removedFillers: job.removedFillers,
          silenceTrimmed: job.silenceTrimmed,
          durationSaved: job.durationSaved,
        });
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        logger.error(`[AudioCleaner] Job ${job.id} failed: ${job.error}`);
        this.emit("clean:failed", { jobId: job.id, error: job.error });
      })
      .finally(() => {
        this.processing = false;
        this.processNext();
      });
  }

  private async runCleaning(
    job: AudioCleanJob,
    request: AudioCleanRequest,
  ): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), `openzigs-clean-${job.id}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const shouldRemoveFiller = request.removeFiller !== false;
    const shouldTrimSilence = request.trimSilence !== false;
    const aggressiveness = request.aggressiveness ?? "moderate";
    const maxSilenceDuration = request.maxSilenceDuration ?? 0.5;

    try {
      // Determine if source is video (needs audio extraction + remux)
      const isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(request.source);
      let audioPath: string;

      if (isVideo) {
        // Extract audio track
        audioPath = path.join(tmpDir, "audio.wav");
        await this.extractAudio(request.source, audioPath);
      } else {
        audioPath = request.source;
      }

      let currentPath = audioPath;
      const regionsToRemove: Array<{ start: number; end: number }> = [];

      // Step 1: Filler detection via Whisper
      if (shouldRemoveFiller && this.audioSidecarUrl) {
        job.status = "transcribing";
        this.emit("clean:progress", {
          jobId: job.id,
          stage: "transcribing",
          progress: 10,
        });

        const fillers = await this.detectFillers(
          audioPath,
          aggressiveness,
          request.fillerWords,
        );
        job.fillerDetections = fillers;
        job.removedFillers = fillers.length;

        for (const filler of fillers) {
          regionsToRemove.push({ start: filler.start, end: filler.end });
          job.durationSaved += filler.end - filler.start;
        }
      }

      // Step 2: Silence detection
      if (shouldTrimSilence) {
        job.status = "detecting";
        this.emit("clean:progress", {
          jobId: job.id,
          stage: "detecting",
          progress: 30,
        });

        const silences = await this.detectSilence(
          audioPath,
          maxSilenceDuration,
        );
        job.silenceRegions = silences;
        job.silenceTrimmed = silences.length;

        for (const silence of silences) {
          // Keep maxSilenceDuration of each silence, trim the rest
          const trimStart = silence.start + maxSilenceDuration;
          if (trimStart < silence.end) {
            regionsToRemove.push({ start: trimStart, end: silence.end });
            job.durationSaved += silence.end - trimStart;
          }
        }
      }

      // Step 3: Apply removals
      job.status = "cleaning";
      this.emit("clean:progress", {
        jobId: job.id,
        stage: "cleaning",
        progress: 50,
      });

      if (regionsToRemove.length > 0) {
        const cleanedAudioPath = path.join(tmpDir, "cleaned.wav");
        await this.removeRegions(
          currentPath,
          cleanedAudioPath,
          regionsToRemove,
        );
        currentPath = cleanedAudioPath;
      }

      // Step 4: Audio enhancement
      if (request.enhanceSpeech || request.deNoise) {
        job.status = "enhancing";
        this.emit("clean:progress", {
          jobId: job.id,
          stage: "enhancing",
          progress: 70,
        });

        const enhancedPath = path.join(tmpDir, "enhanced.wav");
        await this.enhanceAudio(currentPath, enhancedPath, {
          deNoise: request.deNoise ?? false,
          enhanceSpeech: request.enhanceSpeech ?? false,
        });
        currentPath = enhancedPath;
      }

      // Step 5: Output — remux if video, or copy if audio
      this.emit("clean:progress", {
        jobId: job.id,
        stage: "output",
        progress: 90,
      });

      if (isVideo && regionsToRemove.length > 0) {
        await this.remuxVideo(request.source, currentPath, job.outputPath!);
      } else if (currentPath !== request.source) {
        fs.copyFileSync(currentPath, job.outputPath!);
      } else {
        // No changes needed, copy source
        fs.copyFileSync(request.source, job.outputPath!);
      }

      this.emit("clean:progress", {
        jobId: job.id,
        stage: "complete",
        progress: 100,
      });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }

  /** Extract audio from video. */
  private async extractAudio(
    videoPath: string,
    audioPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        videoPath,
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
  }

  /** Detect filler words via Whisper word-level timestamps. */
  async detectFillers(
    audioPath: string,
    aggressiveness: AggressivenessLevel,
    customFillerWords?: string[],
  ): Promise<FillerDetection[]> {
    if (!this.audioSidecarUrl) return [];

    const audioBuffer = fs.readFileSync(audioPath);
    const formData = new FormData();
    formData.append("audio", new Blob([audioBuffer]), "audio.wav");

    const response = await fetch(`${this.audioSidecarUrl}/whisper`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) return [];

    const result = (await response.json()) as {
      segments?: Array<{
        words?: Array<{
          word: string;
          start: number;
          end: number;
          probability: number;
        }>;
      }>;
    };

    const fillerList =
      customFillerWords ?? DEFAULT_FILLER_WORDS[aggressiveness];
    const fillerSet = new Set(fillerList.map((w) => w.toLowerCase().trim()));
    const detections: FillerDetection[] = [];

    for (const segment of result.segments ?? []) {
      for (const word of segment.words ?? []) {
        const cleaned = word.word
          .toLowerCase()
          .trim()
          .replace(/[.,!?;:]/g, "");
        if (fillerSet.has(cleaned) && word.probability < 0.8) {
          detections.push({
            word: cleaned,
            start: word.start,
            end: word.end,
            confidence: 1 - word.probability, // Low prob = high filler confidence
          });
        }
      }
    }

    return detections;
  }

  /** Detect silence regions via FFmpeg silencedetect. */
  async detectSilence(
    audioPath: string,
    minDuration: number,
  ): Promise<SilenceRegion[]> {
    return new Promise((resolve) => {
      const proc = spawn("ffmpeg", [
        "-i",
        audioPath,
        "-af",
        `silencedetect=noise=-30dB:d=${minDuration}`,
        "-f",
        "null",
        "-",
      ]);

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", () => {
        const regions: SilenceRegion[] = [];
        const lines = stderr.split("\n");

        let currentStart: number | null = null;
        for (const line of lines) {
          const startMatch = line.match(/silence_start:\s*(\d+\.?\d*)/);
          const endMatch = line.match(
            /silence_end:\s*(\d+\.?\d*)\s*\|\s*silence_duration:\s*(\d+\.?\d*)/,
          );

          if (startMatch) {
            currentStart = parseFloat(startMatch[1]);
          }
          if (endMatch && currentStart !== null) {
            const end = parseFloat(endMatch[1]);
            const duration = parseFloat(endMatch[2]);
            regions.push({ start: currentStart, end, duration });
            currentStart = null;
          }
        }
        resolve(regions);
      });

      proc.on("error", () => resolve([]));
    });
  }

  /** Remove regions from audio with crossfade. */
  private async removeRegions(
    inputPath: string,
    outputPath: string,
    regions: Array<{ start: number; end: number }>,
  ): Promise<void> {
    if (regions.length === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    // Sort regions by start time and merge overlapping
    const sorted = [...regions].sort((a, b) => a.start - b.start);
    const merged = mergeOverlappingRegions(sorted);

    // Build FFmpeg segment select filter
    // Create a filter that keeps everything OUTSIDE the removed regions
    const keepSegments: string[] = [];
    let lastEnd = 0;
    for (const region of merged) {
      if (region.start > lastEnd) {
        keepSegments.push(
          `between(t,${lastEnd.toFixed(3)},${region.start.toFixed(3)})`,
        );
      }
      lastEnd = region.end;
    }
    // Keep everything after the last removal
    keepSegments.push(`gte(t,${lastEnd.toFixed(3)})`);

    const selectExpr = keepSegments.join("+");
    const filterComplex = `aselect='${selectExpr}',asetpts=N/SR/TB`;

    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-af",
        filterComplex,
        "-y",
        outputPath,
      ]);

      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("Region removal failed")),
      );
      proc.on("error", reject);
    });
  }

  /** Enhance audio with noise reduction and speech normalization. */
  private async enhanceAudio(
    inputPath: string,
    outputPath: string,
    options: { deNoise: boolean; enhanceSpeech: boolean },
  ): Promise<void> {
    const filters: string[] = [];

    if (options.deNoise) {
      filters.push("afftdn=nf=-20");
    }
    if (options.enhanceSpeech) {
      // Normalize loudness to broadcast standards
      filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    }

    if (filters.length === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-af",
        filters.join(","),
        "-y",
        outputPath,
      ]);

      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("Audio enhancement failed")),
      );
      proc.on("error", reject);
    });
  }

  /** Remux video with cleaned audio track. */
  private async remuxVideo(
    videoPath: string,
    audioPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i",
        videoPath,
        "-i",
        audioPath,
        "-c:v",
        "copy",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        "-y",
        outputPath,
      ]);

      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("Remux failed")),
      );
      proc.on("error", reject);
    });
  }
}

/** Merge overlapping time regions. */
export function mergeOverlappingRegions(
  regions: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (regions.length === 0) return [];

  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }

  return merged;
}
