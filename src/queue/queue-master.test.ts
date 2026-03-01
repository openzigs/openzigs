import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueueMaster } from "./queue-master.js";
import type { MediaJob, QueueConfig, TargetNode } from "./types.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(new Error("no config")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: "job-1",
    type: "txt2img",
    requiredModel: "flux-schnell",
    targetNode: "mac-mini",
    payload: { prompt: "a cat" },
    status: "pending",
    resultUrl: null,
    resultMetadata: null,
    projectId: null,
    galleryAssetId: null,
    priority: 0,
    retries: 0,
    maxRetries: 3,
    error: null,
    retryAfter: null,
    createdAt: new Date(),
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeRepo() {
  return {
    listJobs: vi.fn(() => []),
    getPendingJobs: vi.fn(() => []),
    getPendingJobsForModel: vi.fn(() => []),
    getJob: vi.fn(() => null),
    markDispatched: vi.fn(),
    markComplete: vi.fn(),
    markFailed: vi.fn(),
    isProjectComplete: vi.fn(() => ({ complete: false, total: 0 })),
    createAsset: vi.fn(() => "asset-1"),
  };
}

function makeConfig(): QueueConfig {
  return {
    pollIntervalMs: 60000,
    callbackUrl: "http://localhost:3000/api/queue/callback",
    dispatchTimeoutMs: 45 * 60 * 1000,
    macMini: { url: "http://mac-mini:5001" },
    m2Pro: { url: "http://m2-pro:5002" },
  } as QueueConfig;
}

describe("QueueMaster", () => {
  let qm: QueueMaster;
  let repo: ReturnType<typeof makeRepo>;
  let config: QueueConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    repo = makeRepo();
    config = makeConfig();
    qm = new QueueMaster(repo as never, config);
  });

  afterEach(() => {
    qm.stop();
    vi.useRealTimers();
  });

  // ── Lifecycle ──

  describe("start/stop", () => {
    it("starts the polling loop", () => {
      qm.start();
      expect(qm.listenerCount("job:dispatched")).toBe(0); // No listeners yet, but started
    });

    it("start is idempotent", () => {
      qm.start();
      qm.start(); // should not throw
    });

    it("stop clears the timer", () => {
      qm.start();
      qm.stop();
      // Double stop is safe
      qm.stop();
    });
  });

  // ── Node Status ──

  describe("getNodeStatuses", () => {
    it("returns fallback statuses when nodes are unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("unreachable"));
      const statuses = await qm.getNodeStatuses();
      expect(statuses).toHaveLength(3);
      expect(statuses[0]).toMatchObject({ node: "mac-mini", reachable: false });
      expect(statuses[1]).toMatchObject({ node: "m2-pro", reachable: false });
      expect(statuses[2]).toMatchObject({ node: "music", reachable: false });
    });

    it("reports reachable nodes when fetch succeeds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null, model: "flux", model_loaded: false }),
      });
      const statuses = await qm.getNodeStatuses();
      expect(statuses[0].reachable).toBe(true);
    });
  });

  // ── Unload Node ──

  describe("unloadNode", () => {
    it("returns ok when unload succeeds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "unloaded", previous_model: "flux-schnell" }),
      });
      const result = await qm.unloadNode("mac-mini");
      expect(result.ok).toBe(true);
      expect(result.previous_model).toBe("flux-schnell");
    });

    it("returns not ok when unload fails", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });
      const result = await qm.unloadNode("m2-pro");
      expect(result.ok).toBe(false);
    });

    it("handles network error gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("connection refused"));
      const result = await qm.unloadNode("mac-mini");
      expect(result.ok).toBe(false);
    });
  });

  // ── Switch Active Node ──

  describe("switchActiveNode", () => {
    it("unloads competing node and preloads model", async () => {
      // Set up: mac-mini has a model loaded
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "unloaded", previous_model: "flux-schnell" }),
      });

      // First, give mac-mini a loaded model via pollNodeStatus
      // We'll manipulate internal state indirectly by running getNodeStatuses
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, model: "flux-schnell", model_loaded: true }),
      }).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      }).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      await qm.getNodeStatuses();

      // Now switch to m2-pro (should unload mac-mini)
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "unloaded", previous_model: "flux-schnell" }),
      });
      const result = await qm.switchActiveNode("m2-pro");
      expect(result.unloaded).not.toBeNull();
      expect(result.unloaded!.node).toBe("mac-mini");
    });

    it("skips unload when competing node has no model", async () => {
      const result = await qm.switchActiveNode("mac-mini");
      expect(result.unloaded).toBeNull();
      expect(result.loaded).toBeNull();
    });
  });

  // ── Tick / Main Loop ──

  describe("tick", () => {
    it("runs without error when no jobs pending and nodes unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("unreachable"));
      await expect(qm.tick()).resolves.not.toThrow();
    });

    it("recovers stuck dispatched jobs", async () => {
      const stuckJob = makeJob({
        id: "stuck-1",
        status: "dispatched",
        dispatchedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      });
      repo.listJobs.mockReturnValue([stuckJob]);
      mockFetch.mockRejectedValue(new Error("unreachable"));

      const failedHandler = vi.fn();
      qm.on("job:failed", failedHandler);

      await qm.tick();
      expect(repo.markFailed).toHaveBeenCalledWith("stuck-1", expect.stringContaining("Dispatch timeout"));
      expect(failedHandler).toHaveBeenCalled();
    });

    it("dispatches pending image job to mac-mini", async () => {
      const job = makeJob();
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]); // No stuck jobs

      // Health check response for mac-mini
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, model: "flux-schnell", model_loaded: true }),
      })
      // M2 Pro health check
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      })
      // Music sidecar status
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      })
      // Dispatch POST
      .mockResolvedValueOnce({
        status: 202,
        ok: true,
      });

      const dispatchHandler = vi.fn();
      qm.on("job:dispatched", dispatchHandler);

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("job-1");
    });

    it("dispatches pending video job to m2-pro", async () => {
      const job = makeJob({
        id: "vid-1",
        type: "txt2video",
        requiredModel: "ltx-2",
        targetNode: "m2-pro",
      });
      repo.getPendingJobs.mockImplementation((node: string) =>
        node === "m2-pro" ? [job] : []
      );
      repo.getPendingJobsForModel.mockReturnValue([]);
      repo.listJobs.mockReturnValue([]);

      // Mac mini health (unreachable)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      })
      // M2 Pro health check
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      })
      // Music sidecar
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      })
      // Dispatch POST  
      .mockResolvedValueOnce({
        status: 202,
        ok: true,
      });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("vid-1");
    });

    it("marks job failed when dispatch throws", async () => {
      const job = makeJob();
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]);

      // 1: Mac-mini health check OK
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, model: "flux", model_loaded: true }),
      })
      // 2: Dispatch POST fails
      .mockRejectedValueOnce(new Error("dispatch failed"))
      // 3: M2 Pro health check
      .mockRejectedValueOnce(new Error("unreachable"))
      // 4: Music sidecar status
      .mockRejectedValueOnce(new Error("unreachable"));

      await qm.tick();
      expect(repo.markFailed).toHaveBeenCalled();
    });
  });

  // ── Job Completion ──

  describe("handleJobCompletion", () => {
    it("ignores unknown jobs", async () => {
      repo.getJob.mockReturnValue(null);
      await qm.handleJobCompletion("unknown-id", {});
      expect(repo.markComplete).not.toHaveBeenCalled();
    });

    it("marks job failed on error result", async () => {
      const job = makeJob({ id: "fail-1", status: "dispatched" });
      repo.getJob.mockReturnValue(job);

      const handler = vi.fn();
      qm.on("job:failed", handler);

      // Stub tick to avoid side effects
      mockFetch.mockRejectedValue(new Error("not real"));

      await qm.handleJobCompletion("fail-1", { error: "GPU OOM" });
      expect(repo.markFailed).toHaveBeenCalledWith("fail-1", "GPU OOM");
      expect(handler).toHaveBeenCalled();
    });

    it("marks job complete with metadata", async () => {
      const job = makeJob({ id: "ok-1", status: "dispatched" });
      repo.getJob.mockReturnValueOnce(job).mockReturnValueOnce({ ...job, status: "complete" });

      const handler = vi.fn();
      qm.on("job:complete", handler);

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("ok-1", {
        metadata: { result_url: "/downloads/ok-1.png" },
      });
      expect(repo.markComplete).toHaveBeenCalledWith(
        "ok-1",
        "/downloads/ok-1.png",
        expect.anything(),
        undefined,
      );
      expect(handler).toHaveBeenCalled();
    });

    it("saves asset when media_base64 is provided", async () => {
      const job = makeJob({ id: "asset-1", status: "dispatched" });
      repo.getJob.mockReturnValueOnce(job).mockReturnValueOnce({ ...job, status: "complete" });

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("asset-1", {
        media_base64: Buffer.from("fake-png").toString("base64"),
        media_type: "image/png",
        metadata: {},
      });
      expect(repo.createAsset).toHaveBeenCalled();
      expect(repo.markComplete).toHaveBeenCalled();
    });

    it("emits project:complete when all project jobs done", async () => {
      const job = makeJob({ id: "proj-1", status: "dispatched", projectId: "proj-abc" });
      repo.getJob.mockReturnValueOnce(job).mockReturnValueOnce({ ...job, status: "complete" });
      repo.isProjectComplete.mockReturnValue({ complete: true, total: 3 });

      const handler = vi.fn();
      qm.on("project:complete", handler);

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("proj-1", { metadata: {} });
      expect(handler).toHaveBeenCalledWith("proj-abc", 3);
    });
  });

  // ── Stale Result Polling ──

  describe("pollForStaleResults", () => {
    it("recovers results from stale dispatched jobs", async () => {
      const staleJob = makeJob({
        id: "stale-1",
        status: "dispatched",
        dispatchedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
      });

      // First call: recoverStuckJobs - no truly stuck jobs
      repo.listJobs
        .mockReturnValueOnce([]) // recoverStuckJobs
        .mockReturnValueOnce([staleJob]); // pollForStaleResults

      repo.getJob.mockReturnValueOnce(staleJob).mockReturnValueOnce({ ...staleJob, status: "complete" });

      // For pollForStaleResults fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ job_id: "stale-1", status: "complete", metadata: {} }),
      });

      // After that, processNode etc will call fetch too - make them fail gracefully
      mockFetch.mockRejectedValue(new Error("no more"));

      await qm.tick();
      expect(repo.markComplete).toHaveBeenCalled();
    });
  });

  // ── Music Job Processing ──

  describe("music jobs", () => {
    it("dispatches pending music job to music sidecar", async () => {
      const musicJob = makeJob({
        id: "music-1",
        type: "txt2music",
        requiredModel: "ace-step",
        targetNode: "m2-pro",
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation((_node: string, model: string) =>
        model === "ace-step" ? [musicJob] : []
      );
      repo.listJobs.mockReturnValue([]);

      // mac-mini health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      })
      // m2-pro health
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      })
      // Music sidecar status
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      })
      // Music dispatch
      .mockResolvedValueOnce({
        status: 202,
        ok: true,
      });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("music-1");
    });
  });
});
