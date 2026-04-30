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

  it("submits a txt2img job with FluxQ-clamped fallback dims and registers a binding", () => {
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
    // Bug-fix (post-PR-#1017 walkthrough): omitted width/height now fall
    // back to FLUXQ_FALLBACK_DIMS (1024×576) instead of the OOM-inducing
    // 1920×1080 that flux-schnell can't fit on a 12 GB card.
    expect(input.payload.width).toBe(1024);
    expect(input.payload.height).toBe(576);
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

  it("clamps explicit width/height down to FluxQ-recommended (post-#1017 dim cap)", () => {
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
    // Cache empty in this test → clamp ceiling = FLUXQ_FALLBACK_DIMS
    // (1024×576). Both requested dims are LARGER on at least one axis
    // and therefore get pinned down: 1080→1024, 1920→576.
    expect(input.payload.width).toBe(1024);
    expect(input.payload.height).toBe(576);
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
    // Sharp couldn't decode → falls back to FluxQ defaults
    // (FLUXQ_FALLBACK_DIMS = 1024×576) — see post-#1017 dim-clamp fix.
    expect(assets[0].width).toBe(1024);
    expect(assets[0].height).toBe(576);
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
    // Bug-fix (post-PR-#1017 walkthrough): when sharp can't probe an
    // image AND the job payload doesn't carry width/height, we now fall
    // back to FluxQ's `recommended_*` (or FLUXQ_FALLBACK_DIMS = 1024×576
    // when the cache is empty) instead of the old hard-coded 1920×1080
    // that was OOM-killing flux-schnell on 12 GB cards.
    expect(assets[0].width).toBe(1024);
    expect(assets[0].height).toBe(576);
    reg.dispose();
  });

  it("fires onPitchImageReady after a successful persist", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-photo",
      prompt: "a fluffy kitten",
      kind: "image",
      mediaQueueRepo: repo,
    });
    const sourcePath = await makeImageFile("ready.png");
    const ready = vi.fn();
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
      onPitchImageReady: ready,
    });
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "a fluffy kitten", width: 512, height: 512 },
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
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith({
      deckId: "deck-1",
      slideId: "slide-photo",
      slot: "image",
      jobId: enqRes.jobId,
      assetId: enqRes.assetId,
    });
    reg.dispose();
  });

  it("fires onPitchImageFailed and clears the binding on job:failed", async () => {
    const queue = new EventEmitter();
    const repo = mockQueueRepo();
    const enqRes = enqueueSlideImage({
      deckId: "deck-1",
      slideId: "slide-title",
      prompt: "starfield background",
      kind: "background",
      mediaQueueRepo: repo,
    });
    const failed = vi.fn();
    const ready = vi.fn();
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      baseDir,
      onPitchImageReady: ready,
      onPitchImageFailed: failed,
    });
    queue.emit(
      "job:failed",
      {
        id: enqRes.jobId,
        type: "txt2img",
        requiredModel: "flux-schnell",
        targetNode: "image-gen",
        payload: { prompt: "x" },
        status: "failed",
        resultUrl: null,
        resultMetadata: null,
        projectId: "pitch:deck-1",
        galleryAssetId: null,
        priority: 0,
        retries: 3,
        maxRetries: 3,
        error: "CUDA out of memory",
        retryAfter: null,
        createdAt: FROZEN(),
        dispatchedAt: FROZEN(),
        completedAt: FROZEN(),
        notifyViaTelegram: false,
        telegramChatId: null,
      } as MediaJob,
      "CUDA out of memory",
    );
    await reg.flush();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith({
      deckId: "deck-1",
      slideId: "slide-title",
      slot: "background",
      jobId: enqRes.jobId,
      assetId: enqRes.assetId,
      error: "CUDA out of memory",
    });
    // Subsequent late `job:complete` for the same id is now ignored
    // (binding was removed by the failed handler).
    queue.emit("job:complete", {
      id: enqRes.jobId,
      type: "txt2img",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      payload: { prompt: "x" },
      status: "complete",
      resultUrl: null,
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
    expect(ready).not.toHaveBeenCalled();
    reg.dispose();
  });

  it("ignores foreign job:failed events (no binding)", async () => {
    const queue = new EventEmitter();
    const failed = vi.fn();
    const reg = registerImageCompletionListener({
      queueMaster: queue as unknown as Parameters<
        typeof registerImageCompletionListener
      >[0]["queueMaster"],
      pitchRepo,
      onPitchImageFailed: failed,
    });
    queue.emit(
      "job:failed",
      { id: "some-other-job", payload: {} } as unknown as MediaJob,
      "boom",
    );
    await reg.flush();
    expect(failed).not.toHaveBeenCalled();
    reg.dispose();
  });

  // ── Bug-fix (post-PR-#1024 walkthrough): PR #1023's FluxQ refactor
  // changed `MediaJob.resultUrl` from a local filesystem path to a
  // REST asset URL. The listener used to feed that string straight to
  // `fs.copyFile()` (Windows then resolved `/api/queue/...` to drive
  // root → ENOENT). The contract now: resolve `/api/queue/assets/file/`
  // URLs back to the gallery dir before the copy.
  describe("queue asset URL resolution", () => {
    it("translates `/api/queue/assets/file/<name>` resultUrl to <galleryDir>/<name>", async () => {
      const queue = new EventEmitter();
      const repo = mockQueueRepo();
      const enqRes = enqueueSlideImage({
        deckId: "deck-1",
        slideId: "slide-photo",
        prompt: "a fluffy kitten",
        kind: "image",
        mediaQueueRepo: repo,
      });

      // Lay down the file the QueueMaster would have written.
      const galleryDir = join(tmpDir, "gallery");
      mkdirSync(galleryDir, { recursive: true });
      const filename = `${enqRes.jobId}.png`;
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: { r: 10, g: 20, b: 30 },
        },
      })
        .png()
        .toFile(join(galleryDir, filename));

      const reg = registerImageCompletionListener({
        queueMaster: queue as unknown as Parameters<
          typeof registerImageCompletionListener
        >[0]["queueMaster"],
        pitchRepo,
        baseDir,
        galleryDir,
        clock: FROZEN,
      });

      queue.emit("job:complete", {
        id: enqRes.jobId,
        type: "txt2img",
        requiredModel: "flux-schnell",
        targetNode: "image-gen",
        payload: { prompt: "a fluffy kitten", width: 64, height: 32 },
        status: "complete",
        // The post-#1023 contract: REST URL, NOT a filesystem path.
        resultUrl: `/api/queue/assets/file/${filename}`,
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
      expect(assets[0].mime).toBe("image/png");
      expect(assets[0].width).toBe(64);
      expect(assets[0].height).toBe(32);
      expect(existsSync(assets[0].local_path)).toBe(true);
      reg.dispose();
    });

    it("still accepts a legacy absolute filesystem path resultUrl", async () => {
      const queue = new EventEmitter();
      const repo = mockQueueRepo();
      const enqRes = enqueueSlideImage({
        deckId: "deck-1",
        slideId: "slide-photo",
        prompt: "x",
        kind: "image",
        mediaQueueRepo: repo,
      });
      const sourcePath = await makeImageFile("legacy.png");
      const reg = registerImageCompletionListener({
        queueMaster: queue as unknown as Parameters<
          typeof registerImageCompletionListener
        >[0]["queueMaster"],
        pitchRepo,
        baseDir,
        galleryDir: join(tmpDir, "gallery-empty"),
      });
      queue.emit("job:complete", {
        id: enqRes.jobId,
        type: "txt2img",
        requiredModel: "flux-schnell",
        targetNode: "image-gen",
        payload: { prompt: "x", width: 320, height: 180 },
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
      reg.dispose();
    });

    it("rejects a queue-asset URL that escapes the gallery dir via traversal", async () => {
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
        baseDir,
        galleryDir: join(tmpDir, "gallery"),
        auditLogger: { log: auditLog },
      });
      queue.emit("job:complete", {
        id: enqRes.jobId,
        type: "txt2img",
        requiredModel: "flux-schnell",
        targetNode: "image-gen",
        payload: { prompt: "x" },
        status: "complete",
        // Encoded slash should still be rejected (decodeURIComponent →
        // contains `/` → basename-only check fails).
        resultUrl: `/api/queue/assets/file/..%2F..%2Fetc%2Fpasswd`,
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
      expect(pitchRepo.listAssetsForDeck("deck-1")).toEqual([]);
      const events = auditLog.mock.calls.map(
        (c: unknown[]) => (c[0] as { event: string }).event,
      );
      expect(events).toContain("pitch.image.persist_failed");
      reg.dispose();
    });
  });
});
