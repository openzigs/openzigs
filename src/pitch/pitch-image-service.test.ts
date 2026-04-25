import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import sharp from "sharp";
import { PitchRepository } from "./pitch-repository.js";
import {
  enqueueSlideImage,
  registerImageCompletionListener,
  _resetPendingPitchJobsForTest,
  _peekPitchJobBindingForTest,
} from "./pitch-image-service.js";
import type { Slide } from "./pitch-schema.js";
import type { CharacterRepository } from "../characters/character-repository.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { MediaJob, CreateMediaJobInput } from "../queue/types.js";

const FROZEN = () => new Date("2026-04-24T12:00:00.000Z");

const PHOTO_SLIDE: Slide = {
  template: "image_caption",
  content: {
    image: { prompt: "a kitten", url: null, alt: "kitten" },
    caption: "A kitten",
  },
  speaker_notes: "",
  transition: "slide",
  fragments: [],
};
const TITLE_SLIDE: Slide = {
  template: "title",
  content: { title: "Hi" },
  speaker_notes: "",
  transition: "slide",
  fragments: [],
};

let tmpDir: string;
let baseDir: string;
let sourceDir: string;
let db: Database.Database;
let pitchRepo: PitchRepository;

async function makeImageFile(name = "src.png"): Promise<string> {
  const path = join(sourceDir, name);
  await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
    .png()
    .toFile(path);
  return path;
}

beforeEach(() => {
  _resetPendingPitchJobsForTest();
  tmpDir = mkdtempSync(join(tmpdir(), "pitch-image-test-"));
  baseDir = join(tmpDir, "assets");
  sourceDir = join(tmpDir, "src");
  mkdirSync(sourceDir, { recursive: true });
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_kits (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO brand_kits (id, name) VALUES ('kit-1', 'Acme');
  `);
  pitchRepo = new PitchRepository(db, FROZEN);
  pitchRepo.migrate();
  pitchRepo.insertDeck({
    id: "deck-1",
    title: "Demo",
    brand_kit_id: "kit-1",
    metadata: { source_script: "x", tone: "formal" },
    slides: [
      { id: "slide-photo", slide: PHOTO_SLIDE },
      { id: "slide-title", slide: TITLE_SLIDE },
    ],
  });
});

afterEach(() => {
  _resetPendingPitchJobsForTest();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal MediaQueueRepository stub. */
function mockQueueRepo() {
  const createJob = vi.fn((input: CreateMediaJobInput): MediaJob => {
    return {
      id: `job-${createJob.mock.calls.length}`,
      type: input.type,
      requiredModel: input.model ?? "flux-schnell",
      targetNode: "image-gen",
      payload: input.payload,
      status: "pending",
      resultUrl: null,
      resultMetadata: null,
      projectId: input.projectId ?? null,
      galleryAssetId: null,
      priority: input.priority ?? 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: null,
      completedAt: null,
      notifyViaTelegram: false,
      telegramChatId: null,
    };
  });
  return { createJob } as unknown as MediaQueueRepository & {
    createJob: typeof createJob;
  };
}

/** CharacterRepository stub returning a single ready character. */
function mockCharRepoWithMatch(triggerWord: string): CharacterRepository {
  return {
    getByStatus: vi.fn(() => [
      {
        id: "char-1",
        name: "kitten-character",
        triggerWord,
        trainedLoraPath: "/loras/kitten.safetensors",
        loraScale: 0.8,
        description: "fluffy",
        status: "ready",
      },
    ]),
  } as unknown as CharacterRepository;
}

describe("enqueueSlideImage", () => {
  it("rejects an empty prompt", () => {
    const repo = mockQueueRepo();
    expect(() =>
      enqueueSlideImage({
        deckId: "deck-1",
        slideId: "slide-photo",
        prompt: "  ",
        kind: "image",
        mediaQueueRepo: repo,
      }),
    ).toThrow(/prompt is required/);
    expect((repo as unknown as { createJob: ReturnType<typeof vi.fn> }).createJob)
      .not.toHaveBeenCalled();
  });

  it("submits a txt2img job with default 1920×1080 and registers a binding", () => {
    const repo = mockQueueRepo();
    const r = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "a kitten on a beach",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const stub = repo as unknown as { createJob: ReturnType<typeof vi.fn> };
    expect(stub.createJob).toHaveBeenCalledTimes(1);
    const input = stub.createJob.mock.calls[0][0] as CreateMediaJobInput;
    expect(input.type).toBe("txt2img");
    expect(input.payload.width).toBe(1920);
    expect(input.payload.height).toBe(1080);
    expect(input.model).toBe("flux-schnell");
    expect(input.projectId).toBe("pitch:deck-1");
    const binding = _peekPitchJobBindingForTest(r.jobId);
    expect(binding).toMatchObject({
      deckId: "deck-1",
      slideId: "slide-photo",
      kind: "image",
      slot: "image",
      assetId: r.assetId,
    });
  });

  it("calls injectCharacterLora BEFORE createJob (LoRA paths show up on the submitted payload)", () => {
    const repo = mockQueueRepo();
    const charRepo = mockCharRepoWithMatch("sks_kitten");
    const r = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "sks_kitten lounging in the sun",
      kind: "image",
      mediaQueueRepo: repo,
      characterRepo: charRepo,
    });
    const stub = repo as unknown as { createJob: ReturnType<typeof vi.fn> };
    const submittedPayload = (stub.createJob.mock.calls[0][0] as CreateMediaJobInput)
      .payload;
    expect(submittedPayload.lora_paths).toEqual(["/loras/kitten.safetensors"]);
    expect(submittedPayload.lora_scales).toEqual([0.8]);
    expect(r.payload.lora_paths).toEqual(["/loras/kitten.safetensors"]);
  });

  it("does not inject LoRA when no character matches the prompt", () => {
    const repo = mockQueueRepo();
    const charRepo = mockCharRepoWithMatch("sks_dog");
    enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "no triggers in this prompt",
      kind: "image",
      mediaQueueRepo: repo,
      characterRepo: charRepo,
    });
    const stub = repo as unknown as { createJob: ReturnType<typeof vi.fn> };
    const submittedPayload = (stub.createJob.mock.calls[0][0] as CreateMediaJobInput)
      .payload;
    expect(submittedPayload.lora_paths).toBeUndefined();
  });

  it("respects explicit width/height/seed/preferredModel", () => {
    const repo = mockQueueRepo();
    enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "x",
      kind: "background",
      width: 1080,
      height: 1920,
      seed: 42,
      preferredModel: "flux-dev",
      mediaQueueRepo: repo,
    });
    const stub = repo as unknown as { createJob: ReturnType<typeof vi.fn> };
    const input = stub.createJob.mock.calls[0][0] as CreateMediaJobInput;
    expect(input.payload.width).toBe(1080);
    expect(input.payload.height).toBe(1920);
    expect(input.payload.seed).toBe(42);
    expect(input.model).toBe("flux-dev");
  });
});

describe("registerImageCompletionListener", () => {
  it("ignores jobs that weren't enqueued by us", async () => {
    const queue = new EventEmitter() as unknown as Parameters<
      typeof registerImageCompletionListener
    >[0]["queueMaster"];
    const reg = registerImageCompletionListener({
      queueMaster: queue,
      pitchRepo,
    });
    (queue as unknown as EventEmitter).emit("job:complete", {
      id: "foreign-job",
      status: "complete",
      resultUrl: "/tmp/whatever.png",
      payload: { prompt: "x" },
    } as unknown as MediaJob);
    // No throw, no asset row.
    expect(pitchRepo.listAssetsForDeck("deck-1")).toEqual([]);
    reg.dispose();
  });

  it("persists asset + patches inline image slot URL on success", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "a fluffy kitten",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const sourcePath = await makeImageFile();

    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
      clock: FROZEN,
    });

    const completedJob: MediaJob = {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "a fluffy kitten", width: 1920, height: 1080 },
      status: "complete",
      resultUrl: sourcePath,
      resultMetadata: null,
      projectId: "pitch:deck-1",
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    };

    // Listener handler is async — emit then yield.
    queue.emit("job:complete", completedJob);
    await reg.flush();

    const assets = pitchRepo.listAssetsForDeck("deck-1");
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("image");
    expect(assets[0].source).toBe("fluxq");
    expect(assets[0].mime).toBe("image/png");
    expect(assets[0].width).toBe(320); // sharp-detected
    expect(assets[0].height).toBe(180);
    expect(assets[0].local_path).toContain(enqRes.assetId);
    expect(existsSync(assets[0].local_path)).toBe(true);

    // Slide content should now have a file:// URL on its image slot.
    const slide = pitchRepo.getSlide("slide-photo");
    if (slide && slide.slide.template === "image_caption") {
      expect(slide.slide.content.image.url).toMatch(/^file:\/\//);
      expect(slide.slide.content.image.prompt).toBe("a kitten");
    } else {
      throw new Error("expected image_caption slide");
    }

    reg.dispose();
  });

  it("persists asset only (no slide mutation) for kind=background", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-title",
      prompt: "starfield background",
      kind: "background",
      mediaQueueRepo: repo,
    });
    const sourcePath = await makeImageFile("bg.png");
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "starfield", width: 1920, height: 1080 },
      status: "complete",
      resultUrl: sourcePath,
      resultMetadata: null,
      projectId: "pitch:deck-1",
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();

    const assets = pitchRepo.listAssetsForDeck("deck-1");
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("background");
    // Title slide has no image slot; content remains the original.
    const slide = pitchRepo.getSlide("slide-title");
    expect(slide?.slide.template).toBe("title");
    if (slide && slide.slide.template === "title") {
      expect(slide.slide.content.title).toBe("Hi");
    }
    reg.dispose();
  });

  it("logs an audit event when the slot is absent on the slide template", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-title", // title slide has no image slot
      prompt: "a hero shot",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const sourcePath = await makeImageFile("hero.png");
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      auditLogger: { log: auditLog },
      baseDir,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x" },
      status: "complete",
      resultUrl: sourcePath,
      resultMetadata: null,
      projectId: null,
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();

    expect(pitchRepo.listAssetsForDeck("deck-1")).toHaveLength(1);
    const events = auditLog.mock.calls.map(
      (c: unknown[]) => (c[0] as { event: string }).event,
    );
    expect(events).toContain("pitch.image.slot_absent");
    reg.dispose();
  });

  it("logs an audit event for non-success job status and writes nothing to disk", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "x",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      auditLogger: { log: auditLog },
      baseDir,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x" },
      status: "failed",
      resultUrl: null,
      resultMetadata: null,
      projectId: null,
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: "GPU oom",
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();

    expect(pitchRepo.listAssetsForDeck("deck-1")).toEqual([]);
    expect(existsSync(join(baseDir, "deck-1"))).toBe(false);
    expect(auditLog.mock.calls[0][0].event).toBe(
      "pitch.image.job_did_not_succeed",
    );
    reg.dispose();
  });

  it("cleans up the copied file when insertAsset throws (no orphan on disk)", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "x",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const sourcePath = await makeImageFile();

    // Sabotage insertAsset.
    const spy = vi
      .spyOn(pitchRepo, "insertAsset")
      .mockImplementation(() => {
        throw new Error("FK violation");
      });

    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      auditLogger: { log: auditLog },
      baseDir,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x" },
      status: "complete",
      resultUrl: sourcePath,
      resultMetadata: null,
      projectId: null,
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();

    // Insert was attempted, file was cleaned up, audit logged.
    expect(spy).toHaveBeenCalled();
    const dir = join(baseDir, "deck-1");
    if (existsSync(dir)) {
      expect(readdirSync(dir)).toHaveLength(0);
    }
    expect(auditLog.mock.calls.some(
      (c: unknown[]) => (c[0] as { event: string }).event === "pitch.image.persist_failed",
    )).toBe(true);
    reg.dispose();
  });

  it("dispose() detaches the listener", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "x",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
    });
    reg.dispose();
    queue.emit("job:complete", {
      id: enqRes.jobId,
      status: "complete",
      resultUrl: "/whatever",
      payload: { prompt: "x" },
    } as unknown as MediaJob);
    await reg.flush();
    expect(pitchRepo.listAssetsForDeck("deck-1")).toEqual([]);
  });

  it("accepts a `file://` resultUrl, picks ext-based mime, and falls back to default size when sharp can't decode", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "hero shot",
      kind: "image",
      mediaQueueRepo: repo,
    });
    // Write a non-image file with a .jpg extension; sharp will fail to read.
    const corrupt = join(sourceDir, "corrupt.jpg");
    writeFileSync(corrupt, "not actually a jpeg");
    const fileUrl = `file://${corrupt.replace(/\\/g, "/")}`;

    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
      clock: FROZEN,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x" },
      status: "complete",
      resultUrl: fileUrl,
      resultMetadata: null,
      projectId: null,
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();

    const assets = pitchRepo.listAssetsForDeck("deck-1");
    expect(assets).toHaveLength(1);
    expect(assets[0].mime).toBe("image/jpeg");
    // Sharp couldn't decode → falls back to defaults.
    expect(assets[0].width).toBe(1920);
    expect(assets[0].height).toBe(1080);
    reg.dispose();
  });

  it("logs slide_update_failed when updateSlide throws (asset still persisted)", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "x",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const sourcePath = await makeImageFile("u.png");

    // Sabotage updateSlide AFTER insertAsset succeeds.
    vi.spyOn(pitchRepo, "updateSlide").mockImplementation(() => {
      throw new Error("DB locked");
    });

    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      auditLogger: { log: auditLog },
      baseDir,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x", width: 1920, height: 1080 },
      status: "complete",
      resultUrl: sourcePath,
      resultMetadata: null,
      projectId: null,
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();

    expect(pitchRepo.listAssetsForDeck("deck-1")).toHaveLength(1);
    expect(
      auditLog.mock.calls.some(
        (c: unknown[]) =>
          (c[0] as { event: string }).event === "pitch.image.slide_update_failed",
      ),
    ).toBe(true);
    reg.dispose();
  });

  it("handles missing payload width/height (uses defaults)", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "x",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const corrupt = join(sourceDir, "corrupt2.bin");
    writeFileSync(corrupt, "garbage");
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x" }, // no width/height
      status: "complete",
      resultUrl: corrupt,
      resultMetadata: null,
      projectId: null,
      galleryAssetId: null,
      priority: 0,
      retries: 0,
      maxRetries: 3,
      error: null,
      retryAfter: null,
      createdAt: FROZEN(),
      dispatchedAt: FROZEN(),
      completedAt: FROZEN(),
      notifyViaTelegram: false,
      telegramChatId: null,
    } as MediaJob);
    await reg.flush();
    const assets = pitchRepo.listAssetsForDeck("deck-1");
    expect(assets).toHaveLength(1);
    expect(assets[0].mime).toBe("application/octet-stream");
    expect(assets[0].width).toBe(1920);
    expect(assets[0].height).toBe(1080);
    reg.dispose();
  });
});
