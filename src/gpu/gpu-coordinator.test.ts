import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { GpuCoordinator, summariseClaims } from "./gpu-coordinator.js";

function makeCoordinator(now = () => 1_700_000_000_000) {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const warn = vi.fn();
  return {
    db,
    warn,
    coord: new GpuCoordinator({ db, now, warn }),
  };
}

describe("GpuCoordinator", () => {
  it("rejects vLLM when FLUX already claims the same GPUs", () => {
    const { coord } = makeCoordinator();
    expect(coord.register("flux", [0, 1])).toEqual({ ok: true });
    expect(coord.register("vllm", [0, 1])).toEqual({
      ok: false,
      conflictWith: "flux",
      conflictGpus: [0, 1],
    });
  });

  it("rejects FLUX when vLLM is already loaded (vllm is exclusive)", () => {
    const { coord } = makeCoordinator();
    expect(coord.register("vllm", [0, 1])).toEqual({ ok: true });
    const res = coord.register("flux", [0]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflictWith).toBe("vllm");
      expect(res.conflictGpus).toEqual([0]);
    }
  });

  it("allows vLLM on [0,1] and FLUX on [2,3] simultaneously", () => {
    const { coord } = makeCoordinator();
    expect(coord.register("vllm", [0, 1])).toEqual({ ok: true });
    expect(coord.register("flux", [2, 3])).toEqual({ ok: true });
    const claims = coord.currentClaims();
    expect(claims).toHaveLength(2);
  });

  it("allows non-exclusive workloads to share a GPU", () => {
    const { coord } = makeCoordinator();
    expect(coord.register("ltx", [1])).toEqual({ ok: true });
    // lipsync + ltx on the same card is the existing default behaviour.
    expect(coord.register("lipsync", [1])).toEqual({ ok: true });
  });

  it("evicts stale claims older than the configured TTL", () => {
    const db = new Database(":memory:");
    let t = 1_000_000_000_000;
    const warn = vi.fn();
    const coord = new GpuCoordinator({
      db,
      now: () => t,
      staleAfterMs: 60 * 1000,
      warn,
    });
    coord.register("ltx", [1]);
    expect(coord.currentClaims()).toHaveLength(1);
    t += 61 * 1000;
    expect(coord.currentClaims()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("persists claims across coordinator instances (DB persistence)", () => {
    const db = new Database(":memory:");
    const a = new GpuCoordinator({ db });
    a.register("vllm", [0, 1]);
    const b = new GpuCoordinator({ db });
    expect(b.currentClaims()).toEqual([
      { workload: "vllm", gpus: [0, 1], startedAt: expect.any(Number) },
    ]);
  });

  it("unregister returns true when a claim was removed", () => {
    const { coord } = makeCoordinator();
    coord.register("vllm", [0, 1]);
    expect(coord.unregister("vllm")).toBe(true);
    expect(coord.unregister("vllm")).toBe(false);
  });

  it("upserts when the same workload re-registers with new GPUs", () => {
    const { coord } = makeCoordinator();
    coord.register("vllm", [0]);
    coord.register("vllm", [0, 1]);
    const claims = coord.currentClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.gpus).toEqual([0, 1]);
  });

  it("treats an empty GPU list as a no-op success", () => {
    const { coord } = makeCoordinator();
    expect(coord.register("ltx", [])).toEqual({ ok: true });
    expect(coord.currentClaims()).toHaveLength(0);
  });
});

describe("summariseClaims", () => {
  it("returns idle when there are no claims", () => {
    expect(summariseClaims([])).toEqual({ serving_mode: "idle", conflicts: [] });
  });

  it("returns vllm-tp2 when only vLLM is claimed", () => {
    expect(
      summariseClaims([{ workload: "vllm", gpus: [0, 1], startedAt: 0 }]).serving_mode,
    ).toBe("vllm-tp2");
  });

  it("returns diffusion when only diffusion-class workloads are claimed", () => {
    expect(
      summariseClaims([{ workload: "ltx", gpus: [1], startedAt: 0 }]).serving_mode,
    ).toBe("diffusion");
  });

  it("returns mixed when vLLM and diffusion coexist on disjoint GPUs", () => {
    const summary = summariseClaims([
      { workload: "vllm", gpus: [0, 1], startedAt: 0 },
      { workload: "ltx", gpus: [2], startedAt: 0 },
    ]);
    expect(summary.serving_mode).toBe("mixed");
    // Disjoint GPUs — no conflict.
    expect(summary.conflicts).toEqual([]);
  });
});
