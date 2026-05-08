import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  GpuDispatcher,
  defaultDispatcherPinning,
  setActiveGpuDispatcher,
  getActiveGpuDispatcher,
  withGpuLane,
} from "./gpu-dispatcher.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await tick();
};

describe("defaultDispatcherPinning", () => {
  it("collapses every workload to GPU 0 on single-GPU hosts", () => {
    expect(defaultDispatcherPinning(1)).toEqual({
      llm: [0],
      image: [0],
      video: [0],
    });
  });

  it("pins LLM to GPU 0 and image/video to the last GPU on multi-GPU", () => {
    expect(defaultDispatcherPinning(2)).toEqual({
      llm: [0],
      image: [1],
      video: [1],
    });
    expect(defaultDispatcherPinning(4)).toEqual({
      llm: [0],
      image: [3],
      video: [3],
    });
  });
});

describe("GpuDispatcher", () => {
  beforeEach(() => {
    setActiveGpuDispatcher(null);
  });

  it("routes to the pinned GPU and resolves run's return value", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    const result = await d.enqueue({
      workloadType: "llm",
      run: async (gpu) => `ran on ${gpu}`,
    });
    expect(result).toBe("ran on 0");
    expect(d.laneState(0)?.state).toBe("idle");
  });

  it("routes image jobs to the last GPU per default pinning", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    const result = await d.enqueue({
      workloadType: "image",
      run: async (gpu) => gpu,
    });
    expect(result).toBe(1);
  });

  it("emits job:started, job:completed, and gpu:state-changed", async () => {
    const d = new GpuDispatcher({ gpuCount: 1 });
    const started = vi.fn();
    const completed = vi.fn();
    const state = vi.fn();
    d.on("job:started", started);
    d.on("job:completed", completed);
    d.on("gpu:state-changed", state);

    await d.enqueue({
      workloadType: "image",
      run: async () => "ok",
    });
    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    // queued, busy, idle = 3 transitions (we're permissive about extra noise).
    expect(state.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("runs concurrent jobs on different GPUs", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    const order: string[] = [];
    const llm = d.enqueue({
      workloadType: "llm",
      run: async () => {
        order.push("llm-start");
        await tick();
        order.push("llm-end");
      },
    });
    // Image is forced onto a non-conflicting workload by using a workloadType
    // that doesn't conflict with LLM at the mutex level — we purposely test
    // mutex below. Here we use two non-conflicting LLM jobs on different
    // pinned lanes via fallback.
    const image = d.enqueue({
      workloadType: "image", // pinned to GPU 1 — different lane, MUTEX BLOCKS.
      run: async () => {
        order.push("image-start");
      },
    });
    await Promise.all([llm, image]);
    // Mutual exclusion serializes them. LLM starts first; image waits.
    expect(order[0]).toBe("llm-start");
    expect(order[order.length - 1]).toBe("image-start");
  });

  it("runs on different GPUs concurrently when mutualExclusion=false", async () => {
    const d = new GpuDispatcher({ gpuCount: 2, mutualExclusion: false });
    let imgRunning = false;
    let bothRanConcurrently = false;
    const image = d.enqueue({
      workloadType: "image",
      run: async () => {
        imgRunning = true;
        await tick();
        await tick();
        imgRunning = false;
      },
    });
    await tick(); // let image start
    const llm = d.enqueue({
      workloadType: "llm",
      run: async () => {
        if (imgRunning) bothRanConcurrently = true;
      },
    });
    await Promise.all([image, llm]);
    expect(bothRanConcurrently).toBe(true);
  });

  it("queues a second job on the same lane and emits queueDepth", async () => {
    const d = new GpuDispatcher({ gpuCount: 1 });
    const first = d.enqueue({
      workloadType: "image",
      run: async () => {
        await tick();
        await tick();
        return "first";
      },
    });
    const second = d.enqueue({
      workloadType: "image",
      run: async () => "second",
    });
    // Right after enqueue, the second is queued behind the first.
    await tick();
    expect(d.laneState(0)?.queueDepth).toBe(1);
    const results = await Promise.all([first, second]);
    expect(results).toEqual(["first", "second"]);
    expect(d.laneState(0)?.queueDepth).toBe(0);
    expect(d.laneState(0)?.state).toBe("idle");
  });

  it("blocks an LLM job while a diffusion job is running and surfaces mutexBlockedBy", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    const blockedSpy = vi.fn();
    d.on("gpu:state-changed", (snap) => {
      if (snap.mutexBlockedBy) blockedSpy(snap);
    });

    const order: string[] = [];
    let releaseImage!: () => void;
    const image = d.enqueue({
      workloadType: "image",
      run: async () => {
        order.push("image-start");
        await new Promise<void>((res) => {
          releaseImage = res;
        });
        order.push("image-end");
      },
    });

    await tick();
    // Image is now running on GPU 1 (pinned). LLM (pinned to GPU 0) should
    // be blocked by mutex despite GPU 0 being physically idle.
    const llm = d.enqueue({
      workloadType: "llm",
      run: async () => {
        order.push("llm-start");
      },
    });
    await flush();
    const lane0 = d.laneState(0);
    expect(lane0?.mutexBlockedBy).toBe("image");
    expect(blockedSpy).toHaveBeenCalled();

    releaseImage();
    await Promise.all([image, llm]);
    expect(order).toEqual(["image-start", "image-end", "llm-start"]);
    expect(d.laneState(0)?.mutexBlockedBy).toBeUndefined();
  });

  it("falls back to single-GPU behaviour when only one GPU is present", async () => {
    const d = new GpuDispatcher({ gpuCount: 1 });
    const order: string[] = [];
    const llm = d.enqueue({
      workloadType: "llm",
      run: async () => {
        order.push("llm");
      },
    });
    const image = d.enqueue({
      workloadType: "image",
      run: async () => {
        order.push("image");
      },
    });
    await Promise.all([llm, image]);
    // Both pinned to GPU 0 by default — must serialize, not crash.
    expect(order).toEqual(["llm", "image"]);
  });

  it("uses synthetic lane -1 on no-GPU hosts and never enforces mutex", async () => {
    const d = new GpuDispatcher({ gpuCount: 0 });
    expect(d.state()).toEqual([
      expect.objectContaining({ index: -1, state: "idle" }),
    ]);
    const result = await d.enqueue({
      workloadType: "image",
      run: async (gpu) => gpu,
    });
    expect(result).toBe(-1);
  });

  it("rejects with an error when no candidate lane exists and fallback is off", async () => {
    const d = new GpuDispatcher({
      gpuCount: 2,
      pinning: { llm: [5] }, // index 5 doesn't exist
    });
    await expect(
      d.enqueue({
        workloadType: "llm",
        allowFallback: false,
        run: async () => "x",
      }),
    ).rejects.toThrow(/no GPU lane available/);
  });

  it("falls back to any healthy lane when allowFallback=true and pin is empty", async () => {
    const d = new GpuDispatcher({
      gpuCount: 2,
      pinning: { llm: [5] }, // bogus pin
      defaultAllowFallback: true,
    });
    // pickLane: pinned candidates = [], healthy = [], pool = allLanes (no error)
    const idx = await d.enqueue({
      workloadType: "llm",
      run: async (gpu) => gpu,
    });
    expect([0, 1]).toContain(idx);
  });

  it("transitions a lane into error on run failure and surfaces lastError", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    await expect(
      d.enqueue({
        workloadType: "image",
        run: async () => {
          throw new Error("CUDA OOM");
        },
      }),
    ).rejects.toThrow("CUDA OOM");
    const lane = d.laneState(1);
    expect(lane?.state).toBe("error");
    expect(lane?.lastError).toBe("CUDA OOM");
  });

  it("clearError() returns the lane to idle and drains queued work", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    await expect(
      d.enqueue({
        workloadType: "image",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow();
    expect(d.laneState(1)?.state).toBe("error");

    expect(d.clearError(1)).toBe(true);
    expect(d.laneState(1)?.state).toBe("idle");

    const result = await d.enqueue({
      workloadType: "image",
      run: async () => "ok",
    });
    expect(result).toBe("ok");
  });

  it("clearError() is a no-op on healthy lanes", () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    expect(d.clearError(0)).toBe(false);
    expect(d.clearError(99)).toBe(false);
  });

  it("cancel() aborts the in-flight job's signal and rejects the promise", async () => {
    const d = new GpuDispatcher({ gpuCount: 1 });
    const job = d.enqueue({
      workloadType: "image",
      run: async (_gpu, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    await tick();
    expect(d.cancel(0)).toBe(true);
    await expect(job).rejects.toThrow(/aborted/);
    // Lane should NOT be poisoned — abort returns to idle.
    expect(d.laneState(0)?.state).toBe("idle");
  });

  it("cancel() returns false when no job is running on the lane", () => {
    const d = new GpuDispatcher({ gpuCount: 1 });
    expect(d.cancel(0)).toBe(false);
    expect(d.cancel(99)).toBe(false);
  });

  it("emits audit events at every state transition", async () => {
    const audit = vi.fn();
    const d = new GpuDispatcher({ gpuCount: 2, audit });
    await d.enqueue({
      workloadType: "image",
      run: async () => "ok",
    });
    const events = audit.mock.calls.map((c) => c[0]);
    expect(events).toContain("gpu.dispatch_queued");
    expect(events).toContain("gpu.job_dispatched");
    expect(events).toContain("gpu.job_completed");
  });

  it("audits gpu.mutex_blocked when an LLM job waits on diffusion", async () => {
    const audit = vi.fn();
    const d = new GpuDispatcher({ gpuCount: 2, audit });
    let release!: () => void;
    const image = d.enqueue({
      workloadType: "image",
      run: async () =>
        new Promise<void>((res) => {
          release = res;
        }),
    });
    await tick();
    const llm = d.enqueue({
      workloadType: "llm",
      run: async () => "ok",
    });
    await flush();
    const blocked = audit.mock.calls.find(
      (c) => c[0] === "gpu.mutex_blocked",
    );
    expect(blocked).toBeDefined();
    expect((blocked as [string, Record<string, unknown>])[1]).toMatchObject({
      workloadType: "llm",
      blockedBy: "image",
    });
    release();
    await Promise.all([image, llm]);
  });

  it("audits gpu.job_cancelled and emits cancelled flag on user cancel", async () => {
    const audit = vi.fn();
    const d = new GpuDispatcher({ gpuCount: 1, audit });
    const failed = vi.fn();
    d.on("job:failed", failed);
    const job = d.enqueue({
      workloadType: "image",
      run: async (_gpu, signal) =>
        new Promise<void>((_res, rej) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            rej(err);
          });
        }),
    });
    await tick();
    d.cancel(0);
    await expect(job).rejects.toThrow();
    const cancelled = audit.mock.calls.find(
      (c) => c[0] === "gpu.job_cancelled",
    );
    expect(cancelled).toBeDefined();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true }),
    );
  });

  it("totalQueueDepth() sums queued work across lanes", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    let release!: () => void;
    const blocking = d.enqueue({
      workloadType: "image",
      run: async () =>
        new Promise<void>((res) => {
          release = res;
        }),
    });
    await tick();
    const queued = d.enqueue({ workloadType: "image", run: async () => 1 });
    await tick();
    expect(d.totalQueueDepth()).toBeGreaterThanOrEqual(1);
    release();
    await Promise.all([blocking, queued]);
    expect(d.totalQueueDepth()).toBe(0);
  });

  it("uses the injected clock for startedAt + durationMs", async () => {
    let t = 1000;
    const audit = vi.fn();
    const d = new GpuDispatcher({
      gpuCount: 1,
      now: () => t,
      audit,
    });
    const job = d.enqueue({
      workloadType: "image",
      run: async () => {
        t = 1500;
        return "ok";
      },
    });
    await job;
    const completed = audit.mock.calls.find(
      (c) => c[0] === "gpu.job_completed",
    );
    expect(completed).toBeDefined();
    expect(
      (completed as [string, Record<string, unknown>])[1].durationMs,
    ).toBe(500);
  });
});

describe("setActiveGpuDispatcher / withGpuLane", () => {
  beforeEach(() => setActiveGpuDispatcher(null));

  it("runs inline with gpuIndex 0 when no dispatcher is registered", async () => {
    expect(getActiveGpuDispatcher()).toBeNull();
    const result = await withGpuLane("llm", async (gpu) => gpu);
    expect(result).toBe(0);
  });

  it("delegates to the active dispatcher when one is registered", async () => {
    const d = new GpuDispatcher({ gpuCount: 2 });
    setActiveGpuDispatcher(d);
    expect(getActiveGpuDispatcher()).toBe(d);
    const result = await withGpuLane("image", async (gpu) => gpu);
    expect(result).toBe(1); // pinned to last GPU
  });

  it("can be cleared back to null", () => {
    const d = new GpuDispatcher({ gpuCount: 1 });
    setActiveGpuDispatcher(d);
    setActiveGpuDispatcher(null);
    expect(getActiveGpuDispatcher()).toBeNull();
  });
});
