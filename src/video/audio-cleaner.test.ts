/**
 * Audio Cleaner — Unit Tests
 * Issue #820: Filler Word & Pause Removal.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AudioCleaner,
  mergeOverlappingRegions,
  DEFAULT_FILLER_WORDS,
} from "./audio-cleaner.js";

describe("DEFAULT_FILLER_WORDS", () => {
  it("gentle has basic fillers", () => {
    expect(DEFAULT_FILLER_WORDS.gentle).toContain("um");
    expect(DEFAULT_FILLER_WORDS.gentle).toContain("uh");
    expect(DEFAULT_FILLER_WORDS.gentle).not.toContain("like");
  });

  it("moderate extends gentle", () => {
    expect(DEFAULT_FILLER_WORDS.moderate).toContain("um");
    expect(DEFAULT_FILLER_WORDS.moderate).toContain("like");
    expect(DEFAULT_FILLER_WORDS.moderate).toContain("you know");
  });

  it("aggressive extends moderate", () => {
    expect(DEFAULT_FILLER_WORDS.aggressive).toContain("um");
    expect(DEFAULT_FILLER_WORDS.aggressive).toContain("like");
    expect(DEFAULT_FILLER_WORDS.aggressive).toContain("right");
    expect(DEFAULT_FILLER_WORDS.aggressive).toContain("just");
  });
});

describe("mergeOverlappingRegions", () => {
  it("returns empty for empty input", () => {
    expect(mergeOverlappingRegions([])).toEqual([]);
  });

  it("returns single region as-is", () => {
    const result = mergeOverlappingRegions([{ start: 1, end: 3 }]);
    expect(result).toEqual([{ start: 1, end: 3 }]);
  });

  it("merges overlapping regions", () => {
    const result = mergeOverlappingRegions([
      { start: 1, end: 5 },
      { start: 3, end: 8 },
    ]);
    expect(result).toEqual([{ start: 1, end: 8 }]);
  });

  it("keeps non-overlapping regions separate", () => {
    const result = mergeOverlappingRegions([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
    expect(result).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
  });

  it("merges adjacent regions (touching)", () => {
    const result = mergeOverlappingRegions([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]);
    expect(result).toEqual([{ start: 1, end: 5 }]);
  });

  it("handles unsorted input", () => {
    const result = mergeOverlappingRegions([
      { start: 5, end: 7 },
      { start: 1, end: 3 },
      { start: 2, end: 6 },
    ]);
    expect(result).toEqual([{ start: 1, end: 7 }]);
  });

  it("handles multiple merge chains", () => {
    const result = mergeOverlappingRegions([
      { start: 1, end: 3 },
      { start: 2, end: 4 },
      { start: 3.5, end: 6 },
      { start: 10, end: 12 },
    ]);
    expect(result).toEqual([
      { start: 1, end: 6 },
      { start: 10, end: 12 },
    ]);
  });
});

describe("AudioCleaner", () => {
  it("creates a job and assigns an ID", async () => {
    const cleaner = new AudioCleaner();
    vi.spyOn(cleaner as never, "runCleaning" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await cleaner.submit({ source: "/tmp/test.mp3" });

    expect(id).toMatch(/^clean-/);
    const job = cleaner.getJob(id);
    expect(job).toBeDefined();
    expect(job!.source).toBe("/tmp/test.mp3");
  });

  it("lists all jobs", async () => {
    const cleaner = new AudioCleaner();
    vi.spyOn(cleaner as never, "runCleaning" as never).mockResolvedValue(
      undefined as never,
    );

    await cleaner.submit({ source: "/tmp/a.mp3" });
    await cleaner.submit({ source: "/tmp/b.wav" });

    const jobs = cleaner.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("emits clean:queued on submit", async () => {
    const cleaner = new AudioCleaner();
    vi.spyOn(cleaner as never, "runCleaning" as never).mockResolvedValue(
      undefined as never,
    );

    const handler = vi.fn();
    cleaner.on("clean:queued", handler);

    await cleaner.submit({ source: "/tmp/test.mp3" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: expect.stringMatching(/^clean-/) }),
    );
  });

  it("emits clean:complete on success", async () => {
    const cleaner = new AudioCleaner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(cleaner as any, "runCleaning").mockImplementation(
      async (job: any) => {
        job.removedFillers = 5;
        job.silenceTrimmed = 3;
        job.durationSaved = 4.2;
      },
    );

    const handler = vi.fn();
    cleaner.on("clean:complete", handler);

    const id = await cleaner.submit({ source: "/tmp/test.mp3" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: id,
        removedFillers: 5,
        silenceTrimmed: 3,
        durationSaved: 4.2,
      }),
    );
  });

  it("emits clean:failed on error", async () => {
    const cleaner = new AudioCleaner();
    vi.spyOn(cleaner as never, "runCleaning" as never).mockRejectedValue(
      new Error("Test error"),
    );

    const handler = vi.fn();
    cleaner.on("clean:failed", handler);

    const id = await cleaner.submit({ source: "/tmp/test.mp3" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id, error: "Test error" }),
    );
  });

  it("waitForCompletion resolves on success", async () => {
    const cleaner = new AudioCleaner();
    vi.spyOn(cleaner as never, "runCleaning" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await cleaner.submit({ source: "/tmp/test.mp3" });
    const job = await cleaner.waitForCompletion(id, 5000);
    expect(job.status).toBe("complete");
  });

  it("waitForCompletion rejects for unknown job", async () => {
    const cleaner = new AudioCleaner();
    await expect(cleaner.waitForCompletion("nonexistent")).rejects.toThrow(
      "not found",
    );
  });

  it("detectSilence method exists", () => {
    const cleaner = new AudioCleaner();
    expect(typeof cleaner.detectSilence).toBe("function");
  });

  it("detectFillers method exists", () => {
    const cleaner = new AudioCleaner();
    expect(typeof cleaner.detectFillers).toBe("function");
  });
});
