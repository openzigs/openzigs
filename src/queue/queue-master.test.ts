import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueueMaster } from "./queue-master.js";
import type { MediaJob, QueueConfig } from "./types.js";

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
    targetNode: "image-gen",
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
    notifyViaTelegram: false,
    telegramChatId: null,
    ...overrides,
  };
}

function makeRepo() {
  return {
    listJobs: vi.fn((): MediaJob[] => []),
    getPendingJobs: vi.fn((_node?: string): MediaJob[] => []),
    getPendingJobsForModel: vi.fn(
      (_node: string, _model: string): MediaJob[] => [],
    ),
    getJob: vi.fn((): MediaJob | null => null),
    markDispatched: vi.fn(),
    markComplete: vi.fn(),
    markFailed: vi.fn(),
    isProjectComplete: vi.fn(() => ({ complete: false, total: 0 })),
    createAsset: vi.fn(() => "asset-1"),
    getAsset: vi.fn((): Record<string, unknown> | null => null),
  };
}

function makeConfig(): QueueConfig {
  return {
    pollIntervalMs: 60000,
    callbackUrl: "http://localhost:3000/api/queue/callback",
    dispatchTimeoutMs: 45 * 60 * 1000,
    imageGen: { url: "http://image-gen:5001" },
    m2Pro: { url: "http://m2-pro:5002" },
  } as QueueConfig;
}

describe("QueueMaster", () => {
  let qm: QueueMaster;
  let repo: ReturnType<typeof makeRepo>;
  let config: QueueConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockFetch fully to clear persistent mockRejectedValue from previous tests
    mockFetch.mockReset();
    vi.useFakeTimers();
    repo = makeRepo();
    config = makeConfig();
    qm = new QueueMaster(repo as never, config);
  });

  afterEach(() => {
    qm.stop();
    vi.useRealTimers();
  });

  // â”€â”€ Lifecycle â”€â”€

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

  // â”€â”€ Node Status â”€â”€

  describe("getNodeStatuses", () => {
    it("returns fallback statuses when nodes are unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("unreachable"));
      const statuses = await qm.getNodeStatuses();
      expect(statuses).toHaveLength(4);
      expect(statuses[0]).toMatchObject({ node: "image-gen", reachable: false });
      expect(statuses[1]).toMatchObject({ node: "m2-pro", reachable: false });
      expect(statuses[2]).toMatchObject({ node: "music", reachable: false });
      expect(statuses[3]).toMatchObject({ node: "lipsync", reachable: false });
    });

    it("reports reachable nodes when fetch succeeds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            loaded_model: null,
            model: "flux",
            model_loaded: false,
          }),
      });
      const statuses = await qm.getNodeStatuses();
      expect(statuses[0].reachable).toBe(true);
    });
  });

  // â”€â”€ Unload Node â”€â”€

  describe("unloadNode", () => {
    it("returns ok when unload succeeds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "unloaded",
            previous_model: "flux-schnell",
          }),
      });
      const result = await qm.unloadNode("image-gen");
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
      const result = await qm.unloadNode("image-gen");
      expect(result.ok).toBe(false);
    });
  });

  // â”€â”€ Switch Active Node â”€â”€

  describe("switchActiveNode", () => {
    it("unloads competing node and preloads model", async () => {
      // Set up: image-gen has a model loaded
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "unloaded",
            previous_model: "flux-schnell",
          }),
      });

      // First, give image-gen a loaded model via pollNodeStatus
      // We'll manipulate internal state indirectly by running getNodeStatuses
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: "flux-schnell",
              model_loaded: true,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        });
      await qm.getNodeStatuses();

      // Now switch to m2-pro (should unload image-gen)
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "unloaded",
            previous_model: "flux-schnell",
          }),
      });
      const result = await qm.switchActiveNode("m2-pro");
      expect(result.unloaded).not.toBeNull();
      expect(result.unloaded!.node).toBe("image-gen");
    });

    it("skips unload when competing node has no model", async () => {
      const result = await qm.switchActiveNode("image-gen");
      expect(result.unloaded).toBeNull();
      expect(result.loaded).toBeNull();
    });
  });

  // â”€â”€ Tick / Main Loop â”€â”€

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
      expect(repo.markFailed).toHaveBeenCalledWith(
        "stuck-1",
        expect.stringContaining("Dispatch timeout"),
      );
      expect(failedHandler).toHaveBeenCalled();
    });

    it("dispatches pending image job to image-gen", async () => {
      const job = makeJob();
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]); // No stuck jobs

      // Health check response for image-gen
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: "flux-schnell",
              model_loaded: true,
            }),
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
      repo.getPendingJobs.mockImplementation((node?: string) =>
        node === "m2-pro" ? [job] : [],
      );
      repo.getPendingJobsForModel.mockReturnValue([]);
      repo.listJobs.mockReturnValue([]);

      // Mac mini health (unreachable)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: null,
              model_loaded: false,
            }),
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

      // 1: Image-gen health check OK
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: "flux",
              model_loaded: true,
            }),
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

  // â”€â”€ Job Completion â”€â”€

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
      repo.getJob
        .mockReturnValueOnce(job)
        .mockReturnValueOnce({ ...job, status: "complete" });

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
      repo.getJob
        .mockReturnValueOnce(job)
        .mockReturnValueOnce({ ...job, status: "complete" });

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
      const job = makeJob({
        id: "proj-1",
        status: "dispatched",
        projectId: "proj-abc",
      });
      repo.getJob
        .mockReturnValueOnce(job)
        .mockReturnValueOnce({ ...job, status: "complete" });
      repo.isProjectComplete.mockReturnValue({ complete: true, total: 3 });

      const handler = vi.fn();
      qm.on("project:complete", handler);

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("proj-1", { metadata: {} });
      expect(handler).toHaveBeenCalledWith("proj-abc", 3);
    });
  });

  // â”€â”€ Stale Result Polling â”€â”€

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

      repo.getJob
        .mockReturnValueOnce(staleJob)
        .mockReturnValueOnce({ ...staleJob, status: "complete" });

      // For pollForStaleResults fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            job_id: "stale-1",
            status: "complete",
            metadata: {},
          }),
      });

      // After that, processNode etc will call fetch too - make them fail gracefully
      mockFetch.mockRejectedValue(new Error("no more"));

      await qm.tick();
      expect(repo.markComplete).toHaveBeenCalled();
    });
  });

  // â”€â”€ Music Job Processing â”€â”€

  describe("music jobs", () => {
    it("dispatches pending music job to music sidecar", async () => {
      const musicJob = makeJob({
        id: "music-1",
        type: "txt2music",
        requiredModel: "ace-step",
        targetNode: "m2-pro",
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "ace-step" ? [musicJob] : [],
      );
      repo.listJobs.mockReturnValue([]);

      // image-gen health
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: null,
              model_loaded: false,
            }),
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

  // â”€â”€ Remix Job Dispatch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("remix dispatch", () => {
    it("dispatches remix_analyze jobs via music-studio sidecar", async () => {
      const analyzeJob = makeJob({
        id: "remix-a-1",
        type: "remix_analyze",
        requiredModel: "htdemucs_6s",
        targetNode: "local",
        payload: { prompt: "", source_asset_id: "asset-42", device: "cpu" },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "htdemucs_6s" ? [analyzeJob] : [],
      );
      repo.listJobs.mockReturnValue([]);

      // image-gen health (no pending image-gen jobs, but processM2Pro fetches first)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: null,
              model_loaded: false,
            }),
        })
        // m2-pro health
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Music sidecar status
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false }),
        })
        // Music-studio sidecar health
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Remix dispatch to /remix/analyze
        .mockResolvedValueOnce({
          status: 202,
          ok: true,
        })
        // Lipsync sidecar health
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("remix-a-1");

      // Verify correct endpoint was called
      const analyzeCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/remix/analyze"),
      );
      expect(analyzeCall).toBeDefined();
      const body = JSON.parse(analyzeCall![1]?.body as string);
      expect(body.job_id).toBe("remix-a-1");
      expect(body.source_asset_id).toBe("asset-42");
    });

    it("dispatches remix_master jobs via music-studio sidecar", async () => {
      const masterJob = makeJob({
        id: "remix-m-1",
        type: "remix_master",
        requiredModel: "matchering",
        targetNode: "local",
        payload: {
          prompt: "",
          stem_paths: { vocals: "/v.wav", drums: "/d.wav" },
          volumes: { vocals: 1.0, drums: 0.8 },
          muted: { vocals: false, drums: false },
          vibe: "warm_lofi",
        },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "matchering" ? [masterJob] : [],
      );
      repo.listJobs.mockReturnValue([]);

      // image-gen health (no pending image-gen jobs, but processM2Pro fetches first)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              model: null,
              model_loaded: false,
            }),
        })
        // m2-pro health
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Music sidecar status
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false }),
        })
        // Music-studio sidecar health
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Remix dispatch to /remix/master
        .mockResolvedValueOnce({
          status: 202,
          ok: true,
        })
        // Lipsync sidecar health
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("remix-m-1");

      const masterCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/remix/master"),
      );
      expect(masterCall).toBeDefined();
      const body = JSON.parse(masterCall![1]?.body as string);
      expect(body.vibe).toBe("warm_lofi");
      expect(body.stem_paths).toEqual({ vocals: "/v.wav", drums: "/d.wav" });
    });
  });

  // â”€â”€ reportProgress â”€â”€

  describe("reportProgress", () => {
    it("emits job:progress event with stage and progress", () => {
      const handler = vi.fn();
      qm.on("job:progress", handler);
      qm.reportProgress("job-99", {
        stage: "rendering",
        progress: 50,
        message: "half done",
      });
      expect(handler).toHaveBeenCalledWith("job-99", {
        stage: "rendering",
        progress: 50,
        message: "half done",
      });
    });
  });

  // â”€â”€ ensureVramAvailable (tested via processimageGen / processM2Pro) â”€â”€

  describe("VRAM coordination via tick", () => {
    it("unloads m2-pro before dispatching image job to image-gen", async () => {
      const job = makeJob({ id: "img-vram-1", targetNode: "image-gen" });
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]);

      // 1: image-gen health (idle)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            model: "flux-schnell",
            model_loaded: true,
          }),
      });
      // 2: m2-pro health (has model loaded â€” triggers VRAM unload)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: "ltx-2" }),
      });
      // 3: music sidecar
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      // 4: lipsync sidecar
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });

      // Give m2-pro a loaded model via getNodeStatuses first
      await qm.getNodeStatuses();
      mockFetch.mockClear();

      // Now during tick: image-gen health, unload m2-pro, dispatch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            model: "flux-schnell",
            model_loaded: true,
          }),
      });
      // Unload m2-pro
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ status: "unloaded", previous_model: "ltx-2" }),
      });
      // Dispatch image job
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
      // m2-pro health for processM2Pro
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      // Music sidecar
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      // music-studio sidecar
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      // lipsync sidecar
      mockFetch.mockRejectedValueOnce(new Error("skip"));

      await qm.tick();
      // Verify unload was called
      const unloadCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/unload"),
      );
      expect(unloadCall).toBeDefined();
      expect(repo.markDispatched).toHaveBeenCalledWith("img-vram-1");
    });
  });

  // â”€â”€ Image Dispatch Endpoints â”€â”€

  describe("image dispatch endpoints", () => {
    it("dispatches img2img job to /img2img-async endpoint", async () => {
      const job = makeJob({
        id: "i2i-1",
        type: "img2img",
        requiredModel: "flux-schnell",
        payload: {
          prompt: "enhance this",
          init_image: "base64data",
          strength: 0.6,
        },
      });
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]);

      // image-gen health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            model: "flux-schnell",
            model_loaded: true,
          }),
      });
      // Dispatch POST
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
      // m2-pro health
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      // Music sidecar
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      // Music-studio
      mockFetch.mockRejectedValueOnce(new Error("skip"));

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("i2i-1");

      const dispatchCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/img2img-async"),
      );
      expect(dispatchCall).toBeDefined();
      const body = JSON.parse(dispatchCall![1]?.body as string);
      expect(body.image).toBe("base64data");
      expect(body.strength).toBe(0.6);
    });

    it("dispatches kontext job to /kontext-async endpoint", async () => {
      const job = makeJob({
        id: "knt-1",
        type: "txt2img",
        requiredModel: "flux-kontext",
        payload: { prompt: "a kontext image" },
      });
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            model: "flux-kontext",
            model_loaded: true,
          }),
      });
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      mockFetch.mockRejectedValueOnce(new Error("skip"));

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("knt-1");

      const dispatchCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/kontext-async"),
      );
      expect(dispatchCall).toBeDefined();
    });

    it("dispatches image job with lora_paths", async () => {
      const job = makeJob({
        id: "lora-1",
        type: "txt2img",
        requiredModel: "flux-schnell",
        payload: {
          prompt: "a styled image",
          lora_paths: ["/lora/style.safetensors"],
          lora_scales: [0.8],
        },
      });
      repo.getPendingJobs.mockReturnValue([job]);
      repo.listJobs.mockReturnValue([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            model: "flux-schnell",
            model_loaded: true,
          }),
      });
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      mockFetch.mockRejectedValueOnce(new Error("skip"));

      await qm.tick();
      const dispatchCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/generate-async"),
      );
      expect(dispatchCall).toBeDefined();
      const body = JSON.parse(dispatchCall![1]?.body as string);
      expect(body.lora_paths).toEqual(["/lora/style.safetensors"]);
      expect(body.lora_scales).toEqual([0.8]);
    });
  });

  // â”€â”€ Video Dispatch â”€â”€

  describe("video dispatch", () => {
    it("dispatches video job with full payload to m2-pro", async () => {
      const job = makeJob({
        id: "vid-full-1",
        type: "txt2video",
        requiredModel: "ltx-2",
        targetNode: "m2-pro",
        payload: {
          prompt: "a cinematic scene",
          width: 768,
          height: 512,
          num_frames: 97,
          fps: 24,
          pipeline: "distilled",
          negative_prompt: "blurry",
          cfg_scale: 7.5,
          num_inference_steps: 30,
        },
      });
      repo.getPendingJobs.mockImplementation((node?: string) =>
        node === "m2-pro" ? [job] : [],
      );
      repo.getPendingJobsForModel.mockReturnValue([]);
      repo.listJobs.mockReturnValue([]);

      // image-gen health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      });
      // m2-pro health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      // music sidecar
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      // Dispatch POST
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("vid-full-1");

      void mockFetch.mock.calls.find(
        (c) =>
          String(c[0]).includes("/generate") && String(c[0]).includes("m2-pro"),
      );
      // The dispatch call goes to the m2-pro /generate endpoint
      const allCalls = mockFetch.mock.calls;
      const generateCall = allCalls.find((c) => {
        const body = c[1]?.body;
        return body && JSON.parse(body).job_id === "vid-full-1";
      });
      expect(generateCall).toBeDefined();
      const body = JSON.parse(generateCall![1]?.body as string);
      expect(body.negative_prompt).toBe("blurry");
      expect(body.cfg_scale).toBe(7.5);
      expect(body.pipeline).toBe("distilled");
    });
  });

  // â”€â”€ LTX v2 Video Dispatch Fields â”€â”€

  describe("video dispatch with LTX v2 fields", () => {
    it("includes audio, tiling, enhance_prompt in dispatch body", async () => {
      const job = makeJob({
        id: "vid-ltx2-1",
        type: "txt2video",
        requiredModel: "ltx-2",
        targetNode: "m2-pro",
        payload: {
          prompt: "ocean waves with sound",
          audio: true,
          tiling: "conservative",
          enhance_prompt: true,
          pipeline: "dev-two-stage",
          model_repo: "dgrauet/ltx-2.3-mlx-distilled-q4",
        },
      });
      repo.getPendingJobs.mockImplementation((node?: string) =>
        node === "m2-pro" ? [job] : [],
      );
      repo.getPendingJobsForModel.mockReturnValue([]);
      repo.listJobs.mockReturnValue([]);

      // image-gen health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      });
      // m2-pro health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      // music sidecar
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      // Dispatch POST
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("vid-ltx2-1");

      const allCalls = mockFetch.mock.calls;
      const generateCall = allCalls.find((c) => {
        const body = c[1]?.body;
        return body && JSON.parse(body).job_id === "vid-ltx2-1";
      });
      expect(generateCall).toBeDefined();
      const body = JSON.parse(generateCall![1]?.body as string);
      expect(body.audio).toBe(true);
      expect(body.tiling).toBe("conservative");
      expect(body.enhance_prompt).toBe(true);
      expect(body.pipeline).toBe("dev-two-stage");
      expect(body.model_repo).toBe("dgrauet/ltx-2.3-mlx-distilled-q4");
    });

    it("uses defaults for audio/tiling/enhance_prompt when not specified", async () => {
      const job = makeJob({
        id: "vid-defaults-1",
        type: "txt2video",
        requiredModel: "ltx-2",
        targetNode: "m2-pro",
        payload: {
          prompt: "a simple scene",
        },
      });
      repo.getPendingJobs.mockImplementation((node?: string) =>
        node === "m2-pro" ? [job] : [],
      );
      repo.getPendingJobsForModel.mockReturnValue([]);
      repo.listJobs.mockReturnValue([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });

      await qm.tick();

      const allCalls = mockFetch.mock.calls;
      const generateCall = allCalls.find((c) => {
        const body = c[1]?.body;
        return body && JSON.parse(body).job_id === "vid-defaults-1";
      });
      expect(generateCall).toBeDefined();
      const body = JSON.parse(generateCall![1]?.body as string);
      expect(body.audio).toBe(false);
      expect(body.tiling).toBe("auto");
      expect(body.enhance_prompt).toBe(false);
      expect(body.model_repo).toBeUndefined();
    });

    it("passes image_strength and seed for img2video jobs", async () => {
      const job = makeJob({
        id: "vid-i2v-1",
        type: "img2video",
        requiredModel: "ltx-2",
        targetNode: "m2-pro",
        payload: {
          prompt: "animate this",
          init_image: "base64data==",
          image_strength: 0.7,
          seed: 42,
        },
      });
      repo.getPendingJobs.mockImplementation((node?: string) =>
        node === "m2-pro" ? [job] : [],
      );
      repo.getPendingJobsForModel.mockReturnValue([]);
      repo.listJobs.mockReturnValue([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });

      await qm.tick();

      const allCalls = mockFetch.mock.calls;
      const generateCall = allCalls.find((c) => {
        const body = c[1]?.body;
        return body && JSON.parse(body).job_id === "vid-i2v-1";
      });
      expect(generateCall).toBeDefined();
      const body = JSON.parse(generateCall![1]?.body as string);
      expect(body.init_image).toBe("base64data==");
      expect(body.image_strength).toBe(0.7);
      expect(body.seed).toBe(42);
    });
  });

  // â”€â”€ Music Studio (voice2voice) Dispatch â”€â”€

  describe("music-studio voice2voice dispatch", () => {
    it("dispatches voice2voice job through music-studio sidecar", async () => {
      const v2vJob = makeJob({
        id: "v2v-1",
        type: "voice2voice",
        requiredModel: "seed-vc",
        targetNode: "local",
        payload: {
          prompt: "",
          source_asset_id: "src-asset-1",
          voice_reference_id: "ref-1",
          diffusion_steps: 25,
        },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) => (model === "seed-vc" ? [v2vJob] : []),
      );
      repo.listJobs.mockReturnValue([]);
      repo.getAsset.mockReturnValue({ file_path: "/tmp/source.wav" });

      // image-gen health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      });
      // m2-pro health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      // Music sidecar
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      // Music-studio sidecar health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
      });
      // Dispatch POST
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("v2v-1");

      const generateCall = mockFetch.mock.calls.find((c) => {
        const body = c[1]?.body;
        return body && String(body).includes("v2v-1");
      });
      expect(generateCall).toBeDefined();
      const body = JSON.parse(generateCall![1]?.body as string);
      expect(body.source_asset_id).toBe("src-asset-1");
      expect(body.source_path).toBe("/tmp/source.wav");
      expect(body.voice_reference_id).toBe("ref-1");
    });
  });

  // â”€â”€ handleJobCompletion for voice2voice / remix jobs â”€â”€

  describe("handleJobCompletion clears sidecar busy flags", () => {
    it("clears musicStudioStatus for voice2voice completion", async () => {
      const job = makeJob({
        id: "v2v-done",
        status: "dispatched",
        type: "voice2voice",
        targetNode: "local",
      });
      repo.getJob
        .mockReturnValueOnce(job)
        .mockReturnValueOnce({ ...job, status: "complete" });

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("v2v-done", { metadata: {} });
      expect(repo.markComplete).toHaveBeenCalled();
    });

    it("clears musicStudioStatus for remix job completion", async () => {
      const job = makeJob({
        id: "rmx-done",
        status: "dispatched",
        type: "remix_analyze",
        targetNode: "local",
      });
      repo.getJob
        .mockReturnValueOnce(job)
        .mockReturnValueOnce({ ...job, status: "complete" });

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("rmx-done", { metadata: {} });
      expect(repo.markComplete).toHaveBeenCalled();
    });

    it("clears musicStatus for txt2music completion", async () => {
      const job = makeJob({
        id: "mus-done",
        status: "dispatched",
        type: "txt2music",
        targetNode: "m2-pro",
      });
      repo.getJob
        .mockReturnValueOnce(job)
        .mockReturnValueOnce({ ...job, status: "complete" });

      mockFetch.mockRejectedValue(new Error(""));

      await qm.handleJobCompletion("mus-done", { metadata: {} });
      expect(repo.markComplete).toHaveBeenCalled();
    });
  });

  // â”€â”€ switchActiveNode with model preload â”€â”€

  describe("switchActiveNode with model preload", () => {
    it("preloads model on image-gen after unloading competing node", async () => {
      // Give m2-pro a loaded model
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ is_busy: false, model: null, model_loaded: false }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false, loaded_model: "ltx-2" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ is_busy: false }),
      });
      await qm.getNodeStatuses();

      // switchActiveNode â†’ image-gen with model preload
      // 1: Unload m2-pro
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ status: "unloaded", previous_model: "ltx-2" }),
      });
      // 2: Preload on image-gen POST /model
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await qm.switchActiveNode("image-gen", "flux-schnell");
      expect(result.unloaded).toMatchObject({ node: "m2-pro" });
      expect(result.loaded).toMatchObject({
        node: "image-gen",
        model: "flux-schnell",
      });
    });

    it("handles preload failure gracefully", async () => {
      // switchActiveNode with no competing model â†’ no unload needed
      // Preload POST fails
      mockFetch.mockRejectedValueOnce(new Error("connect refused"));

      const result = await qm.switchActiveNode("image-gen", "flux-schnell");
      expect(result.unloaded).toBeNull();
      expect(result.loaded).toBeNull();
    });
  });

  // â”€â”€ Stale Busy Flag Recovery â”€â”€

  describe("stale busy flag recovery", () => {
    it("clears stale image-gen busy flag when no dispatched jobs exist", async () => {
      const job = makeJob({ id: "after-stale", targetNode: "image-gen" });
      repo.getPendingJobs.mockReturnValue([job]);
      // No dispatched jobs â€” the busy flag is stale
      repo.listJobs.mockReturnValue([]);

      // image-gen health returns idle
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            is_busy: false,
            model: "flux-schnell",
            model_loaded: true,
          }),
      });
      // Dispatch POST
      mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
      // m2-pro + music + music-studio
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      mockFetch.mockRejectedValueOnce(new Error("skip"));
      mockFetch.mockRejectedValueOnce(new Error("skip"));

      await qm.tick();
      expect(repo.markDispatched).toHaveBeenCalledWith("after-stale");
    });

    it("recovers local stuck jobs and clears musicStudioStatus", async () => {
      const stuckLocal = makeJob({
        id: "stuck-local",
        status: "dispatched",
        targetNode: "local",
        type: "remix_analyze",
        dispatchedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago â€” beyond 15 min local timeout
      });
      repo.listJobs.mockReturnValue([stuckLocal]);
      mockFetch.mockRejectedValue(new Error("unreachable"));

      const failedHandler = vi.fn();
      qm.on("job:failed", failedHandler);

      await qm.tick();
      expect(repo.markFailed).toHaveBeenCalledWith(
        "stuck-local",
        expect.stringContaining("Dispatch timeout"),
      );
      expect(failedHandler).toHaveBeenCalled();
    });
  });

  // â”€â”€ Memory Coordination (LTX â†” LatentSync) â”€â”€

  describe("ensureSidecarMemory", () => {
    it("unloads LTX (m2-pro) before lipsync dispatch when model is loaded", async () => {
      // Seed m2-pro as having a loaded model via getNodeStatuses
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              loaded_model: "ltx-2",
            }),
        }) // image-gen health
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              loaded_model: "ltx-video-0.9.1",
            }),
        }) // m2-pro health (has model loaded)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // music unreachable â€” use resolved empty
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ busy: false, loaded_model: null }),
        }); // lipsync health

      await qm.getNodeStatuses();

      // Now mock the unload call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "unloaded",
            previous_model: "ltx-video-0.9.1",
          }),
      });

      await qm.ensureSidecarMemory("lipsync");

      // Verify unload was called on m2-pro
      const unloadCall = mockFetch.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("m2-pro") &&
          c[0].endsWith("/unload"),
      );
      expect(unloadCall).toBeDefined();
    });

    it("unloads LatentSync before LTX dispatch when lipsync model is loaded", async () => {
      // Seed lipsync as having a loaded model - simulate via lipsync health returning loaded model
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        }) // image-gen
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        }) // m2-pro
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // music
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              busy: false,
              loaded_model: "latentsync-v1.5",
            }),
        }); // lipsync health â€” has model loaded

      await qm.getNodeStatuses();

      // Now mock the lipsync unload-model call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "unloaded" }),
      });

      await qm.ensureSidecarMemory("ltx");

      // Verify unload-model was called on lipsync sidecar
      const unloadCall = mockFetch.mock.calls.find(
        (c) =>
          typeof c[0] === "string" && c[0].includes("/unload-model"),
      );
      expect(unloadCall).toBeDefined();
    });

    it("skips unload if target sidecar is already the active one", async () => {
      // Seed lipsync as loaded, m2-pro as empty
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        }) // image-gen
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        }) // m2-pro
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // music
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              busy: false,
              loaded_model: "latentsync-v1.5",
            }),
        }); // lipsync - loaded

      await qm.getNodeStatuses();

      const callsBefore = mockFetch.mock.calls.length;

      // Requesting lipsync when lipsync is already active â€” no unload needed
      await qm.ensureSidecarMemory("lipsync");

      // No additional fetch calls made (no unload needed)
      expect(mockFetch.mock.calls.length).toBe(callsBefore);
    });

    it("throws if concurrent memory transitions are attempted", async () => {
      // Seed m2-pro as loaded
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              loaded_model: "ltx-video-0.9.1",
            }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ busy: false, loaded_model: null }),
        });

      await qm.getNodeStatuses();

      // Mock unload that takes a while (won't resolve immediately)
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: () =>
                    Promise.resolve({
                      status: "unloaded",
                      previous_model: "ltx-video-0.9.1",
                    }),
                }),
              5000,
            ),
          ),
      );

      // Start first transition (won't complete immediately)
      const first = qm.ensureSidecarMemory("lipsync");

      // Second concurrent call should throw
      await expect(qm.ensureSidecarMemory("ltx")).rejects.toThrow(
        "Memory transition already in progress",
      );

      // Advance timer and let first complete
      await vi.advanceTimersByTimeAsync(5000);
      await first;
    });

    it("retries unload up to 3 times on failure then proceeds (best-effort)", async () => {
      // Seed m2-pro as loaded
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              is_busy: false,
              loaded_model: "ltx-video-0.9.1",
            }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ busy: false, loaded_model: null }),
        });

      await qm.getNodeStatuses();

      // Fail all unload attempts
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        });

      const promise = qm.ensureSidecarMemory("lipsync");

      // Advance through retries (2s backoff between attempts) â€” use async to flush microtasks
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);

      // ensureSidecarMemory is best-effort — catches errors and proceeds
      await expect(promise).resolves.toBeUndefined();
    });

    it("gracefully handles unreachable lipsync sidecar during unload", async () => {
      // Seed lipsync as having a loaded model
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              busy: false,
              loaded_model: "latentsync-v1.5",
            }),
        });

      await qm.getNodeStatuses();

      // Lipsync sidecar unreachable during unload
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      // Should not throw â€” graceful skip
      await qm.ensureSidecarMemory("ltx");
    });
  });

  // â”€â”€ TTS Dispatch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("TTS dispatch to audio sidecar", () => {
    it("dispatches TTS job to audio sidecar /tts and handles sync response", async () => {
      const ttsJob = makeJob({
        id: "tts-1",
        type: "tts",
        requiredModel: "f5-tts",
        targetNode: "m2-pro",
        payload: { prompt: "Hello world", voice: "af_heart" },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "f5-tts" ? [ttsJob] : [],
      );
      repo.listJobs.mockReturnValue([]);
      repo.getJob.mockReturnValue(ttsJob);

      // Build a fake WAV response body
      const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

      // processimageGen: no pending image-gen jobs â†’ no health check
      // processM2Pro: health check â†’ no pending non-audio m2-pro jobs
      // processTtsJobs: audio sidecar health â†’ /tts call
      // processMusicJobs: music sidecar status unreachable
      // processMusicStudioJobs: music-studio health unreachable
      // processLipSyncJobs: lipsync health unreachable
      // handleJobCompletion calls void this.tick() â†’ second tick with all unreachable
      mockFetch
        // m2-pro health (processM2Pro)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Audio sidecar health (processTtsJobs)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: "ready" }),
        })
        // Audio sidecar /tts response (sync â€” returns WAV directly)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(fakeWav.buffer),
        })
        // Remaining sidecar checks + re-tick all return unreachable
        .mockRejectedValue(new Error("unreachable"));

      await qm.tick();

      expect(repo.markDispatched).toHaveBeenCalledWith("tts-1");

      // Verify the /tts call was made with correct payload
      const ttsCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/tts"),
      );
      expect(ttsCall).toBeDefined();
      const body = JSON.parse(ttsCall![1]?.body as string);
      expect(body.text).toBe("Hello world");
      expect(body.voice).toBe("af_heart");

      // handleJobCompletion saves to gallery and marks complete
      expect(repo.markComplete).toHaveBeenCalledWith(
        "tts-1",
        expect.any(String),
        undefined,
        "asset-1",
      );
    });

    it("skips TTS jobs when audio sidecar is unreachable", async () => {
      const ttsJob = makeJob({
        id: "tts-2",
        type: "tts",
        requiredModel: "f5-tts",
        targetNode: "m2-pro",
        payload: { prompt: "Test", voice: "af_heart" },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "f5-tts" ? [ttsJob] : [],
      );
      repo.listJobs.mockReturnValue([]);

      // processM2Pro health â†’ processTtsJobs audio sidecar health = unreachable
      mockFetch
        // m2-pro health (processM2Pro)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Audio sidecar health â€” unreachable
        .mockRejectedValueOnce(new Error("Connection refused"))
        // Remaining sidecar checks
        .mockRejectedValue(new Error("unreachable"));

      await qm.tick();

      // TTS job should NOT be dispatched
      expect(repo.markDispatched).not.toHaveBeenCalledWith("tts-2");
    });

    it("TTS jobs are excluded from M2 Pro video dispatch", async () => {
      const ttsJob = makeJob({
        id: "tts-3",
        type: "tts",
        requiredModel: "f5-tts",
        targetNode: "m2-pro",
        payload: { prompt: "Excluded", voice: "af_heart" },
      });

      // processM2Pro filters by !AUDIO_JOB_TYPES â€” tts is now in that set
      repo.getPendingJobs.mockReturnValue([ttsJob]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "f5-tts" ? [ttsJob] : [],
      );
      repo.listJobs.mockReturnValue([]);
      repo.getJob.mockReturnValue(ttsJob);

      const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

      mockFetch
        // m2-pro health (processM2Pro)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Audio sidecar health (processTtsJobs)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: "ready" }),
        })
        // Audio sidecar /tts
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(fakeWav.buffer),
        })
        // Remaining sidecar checks + re-tick
        .mockRejectedValue(new Error("unreachable"));

      await qm.tick();

      // Verify /generate was NOT called (video dispatch), only /tts was
      const generateCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].endsWith("/generate"),
      );
      expect(generateCall).toBeUndefined();

      const ttsCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/tts"),
      );
      expect(ttsCall).toBeDefined();
    });

    it("marks TTS job as failed when sidecar returns error", async () => {
      const ttsJob = makeJob({
        id: "tts-4",
        type: "tts",
        requiredModel: "f5-tts",
        targetNode: "m2-pro",
        payload: { prompt: "Error case" },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "f5-tts" ? [ttsJob] : [],
      );
      repo.listJobs.mockReturnValue([]);

      mockFetch
        // m2-pro health (processM2Pro)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Audio sidecar health (processTtsJobs)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: "ready" }),
        })
        // Audio sidecar /tts â€” returns 500
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("TTS synthesis failed: model not loaded"),
        })
        // Remaining sidecar checks
        .mockRejectedValue(new Error("unreachable"));

      await qm.tick();

      expect(repo.markDispatched).toHaveBeenCalledWith("tts-4");
      expect(repo.markFailed).toHaveBeenCalledWith(
        "tts-4",
        expect.stringContaining("Audio sidecar /tts returned 500"),
      );
    });

    it("sends reference audio as ref_audio_path when provided", async () => {
      const ttsJob = makeJob({
        id: "tts-5",
        type: "tts",
        requiredModel: "f5-tts",
        targetNode: "m2-pro",
        payload: {
          prompt: "Clone voice",
          voice: "af_heart",
          reference_audio: "AAAA", // base64 audio data
        },
      });

      repo.getPendingJobs.mockReturnValue([]);
      repo.getPendingJobsForModel.mockImplementation(
        (_node: string, model: string) =>
          model === "f5-tts" ? [ttsJob] : [],
      );
      repo.listJobs.mockReturnValue([]);
      repo.getJob.mockReturnValue(ttsJob);

      const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

      mockFetch
        // m2-pro health (processM2Pro)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ is_busy: false, loaded_model: null }),
        })
        // Audio sidecar health (processTtsJobs)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: "ready" }),
        })
        // Audio sidecar /tts
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(fakeWav.buffer),
        })
        // Remaining sidecar checks + re-tick
        .mockRejectedValue(new Error("unreachable"));

      await qm.tick();

      expect(repo.markDispatched).toHaveBeenCalledWith("tts-5");

      // Verify fetch was called with /tts endpoint and the payload includes ref_audio_path
      const ttsCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/tts"),
      );
      expect(ttsCall).toBeDefined();
      const body = JSON.parse(ttsCall![1]?.body as string);
      expect(body.text).toBe("Clone voice");
      expect(body.voice).toBe("af_heart");
      // reference_audio should be decoded to a temp file path
      expect(body.ref_audio_path).toBeDefined();
    });
  });
});
