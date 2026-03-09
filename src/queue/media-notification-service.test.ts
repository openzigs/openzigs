import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MediaNotificationService } from "./media-notification-service.js";
import type { MediaJob } from "./types.js";
import type { RenderJob, RenderResult } from "../video/render-types.js";

// ── Test doubles ─────────────────────────────────────────────

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMockQueueMaster() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}

function createMockRenderOrchestrator() {
  const emitter = new EventEmitter();
  const jobs = new Map<string, Partial<RenderJob>>();
  return {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    getJob: (jobId: string) => jobs.get(jobId) ?? null,
    _setJob: (jobId: string, job: Partial<RenderJob>) => jobs.set(jobId, job),
  };
}

function createMockTelegram(connected = true) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockChannelManager(telegram?: ReturnType<typeof createMockTelegram>) {
  return {
    getChannel: vi.fn().mockImplementation((type: string) => type === "telegram" ? telegram : undefined),
    broadcast: vi.fn(),
    register: vi.fn(),
    listChannels: vi.fn().mockReturnValue([]),
  };
}

function makeMediaJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: "job-1",
    type: "txt2img",
    status: "complete",
    requiredModel: "flux-schnell",
    targetNode: "local",
    payload: { prompt: "a sunset over mountains" },
    resultUrl: "https://example.com/result.png",
    resultMetadata: null,
    error: null,
    retryAfter: null,
    createdAt: new Date(),
    dispatchedAt: null,
    completedAt: null,
    notifyViaTelegram: false,
    telegramChatId: null,
    projectId: null,
    galleryAssetId: null,
    priority: 0,
    retries: 0,
    maxRetries: 3,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("MediaNotificationService", () => {
  let queueMaster: ReturnType<typeof createMockQueueMaster>;
  let renderOrchestrator: ReturnType<typeof createMockRenderOrchestrator>;
  let telegram: ReturnType<typeof createMockTelegram>;
  let channelManager: ReturnType<typeof createMockChannelManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    queueMaster = createMockQueueMaster();
    renderOrchestrator = createMockRenderOrchestrator();
    telegram = createMockTelegram();
    channelManager = createMockChannelManager(telegram);
  });

  function createService(fallbackChatId?: string) {
    return new MediaNotificationService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queueMaster: queueMaster as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderOrchestrator: renderOrchestrator as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channelManager: channelManager as any,
      fallbackChatId,
      log: silentLog,
    });
  }

  // ── Queue job notifications ───────────────────────────────

  it("sends Telegram notification on job:complete when opted in", async () => {
    createService();
    const job = makeMediaJob({ notifyViaTelegram: true, telegramChatId: "chat-abc" });

    queueMaster.emit("job:complete", job);
    await vi.runAllTimersAsync?.().catch(() => undefined);
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const [chatId, content] = telegram.sendMessage.mock.calls[0];
    expect(chatId).toBe("chat-abc");
    expect(content.text).toContain("✅");
    expect(content.text).toContain("sunset over mountains");
    expect(content.markdown).toBe(true);
  });

  it("does not send notification on job:complete when not opted in", async () => {
    createService();
    queueMaster.emit("job:complete", makeMediaJob({ notifyViaTelegram: false }));
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends failure notification on job:failed when opted in", async () => {
    createService();
    const job = makeMediaJob({ notifyViaTelegram: true, telegramChatId: "chat-abc" });

    queueMaster.emit("job:failed", job, "GPU out of memory");
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const [, content] = telegram.sendMessage.mock.calls[0];
    expect(content.text).toContain("❌");
    expect(content.text).toContain("GPU out of memory");
  });

  it("uses fallback chatId when job has no telegramChatId", async () => {
    createService("fallback-chat-123");
    const job = makeMediaJob({ notifyViaTelegram: true, telegramChatId: null });

    queueMaster.emit("job:complete", job);
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.sendMessage.mock.calls[0][0]).toBe("fallback-chat-123");
  });

  it("warns and skips when notifyViaTelegram=true but no chatId and no fallback", async () => {
    createService(/* no fallback */);
    const job = makeMediaJob({ notifyViaTelegram: true, telegramChatId: null });

    queueMaster.emit("job:complete", job);
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(silentLog.warn).toHaveBeenCalledWith(expect.stringContaining("no chatId"));
  });

  it("gracefully degrades when telegram channel is not registered", async () => {
    const mgr = createMockChannelManager(undefined /* no telegram */);
    new MediaNotificationService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queueMaster: queueMaster as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderOrchestrator: renderOrchestrator as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channelManager: mgr as any,
      fallbackChatId: "chat-abc",
      log: silentLog,
    });

    const job = makeMediaJob({ notifyViaTelegram: true, telegramChatId: "chat-abc" });
    queueMaster.emit("job:complete", job);
    await new Promise((r) => setImmediate(r));

    expect(silentLog.warn).toHaveBeenCalledWith(expect.stringContaining("not registered"));
  });

  it("gracefully degrades when telegram channel is not connected", async () => {
    telegram = createMockTelegram(false /* disconnected */);
    channelManager = createMockChannelManager(telegram);
    createService("chat-abc");

    const job = makeMediaJob({ notifyViaTelegram: true, telegramChatId: "chat-abc" });
    queueMaster.emit("job:complete", job);
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(silentLog.warn).toHaveBeenCalledWith(expect.stringContaining("not connected"));
  });

  // ── Render notifications ──────────────────────────────────

  it("sends Telegram notification on render:complete when opted in", async () => {
    createService();
    renderOrchestrator._setJob("render-1", {
      notifyViaTelegram: true,
      telegramChatId: "chat-abc",
      manifest: { projectTitle: "My Film" } as RenderJob["manifest"],
    });

    const result: RenderResult = {
      jobId: "render-1",
      success: true,
      outputPath: "/outputs/my-film.mp4",
      error: null,
      durationSec: 42,
      fileSizeBytes: 1024,
    };
    renderOrchestrator.emit("render:complete", result);
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const [chatId, content] = telegram.sendMessage.mock.calls[0];
    expect(chatId).toBe("chat-abc");
    expect(content.text).toContain("🎬");
    expect(content.text).toContain("My Film");
    expect(content.text).toContain("my-film.mp4");
  });

  it("does not send notification on render:complete when not opted in", async () => {
    createService();
    renderOrchestrator._setJob("render-2", {
      notifyViaTelegram: false,
      manifest: { projectTitle: "Silent Film" } as RenderJob["manifest"],
    });

    renderOrchestrator.emit("render:complete", { jobId: "render-2", success: true, outputPath: "/out/f.mp4", error: null, durationSec: null, fileSizeBytes: null });
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends failure notification on render:failed when opted in", async () => {
    createService();
    renderOrchestrator._setJob("render-3", {
      notifyViaTelegram: true,
      telegramChatId: "chat-xyz",
      manifest: { projectTitle: "Epic Fail" } as RenderJob["manifest"],
    });

    renderOrchestrator.emit("render:failed", { jobId: "render-3", error: "Renderer crashed" });
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const [, content] = telegram.sendMessage.mock.calls[0];
    expect(content.text).toContain("❌");
    expect(content.text).toContain("Epic Fail");
    expect(content.text).toContain("Renderer crashed");
  });

  it("skips render:complete silently when job not found in orchestrator", async () => {
    createService();
    // No job set for "render-99"
    renderOrchestrator.emit("render:complete", { jobId: "render-99", outputPath: "/out/x.mp4" });
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
