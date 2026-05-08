/**
 * GPU dispatcher admin endpoints (Issue #1059 / #1060).
 *
 *   POST /api/admin/gpu/dispatcher/:gpuIndex/cancel
 *      Aborts the in-flight job on the given GPU. Returns 200 with
 *      `{ cancelled: true }` when a job was aborted, 404 with
 *      `{ cancelled: false }` when the lane was idle.
 *
 *   POST /api/admin/gpu/dispatcher/:gpuIndex/clear-error
 *      Clears an `error` state on the given lane (UI "Retry" button).
 *
 *   GET  /api/admin/gpu/dispatcher
 *      Snapshot of every lane (mirrors what /api/system/gpu returns
 *      under `dispatcher.gpus` — exposed here for direct polling and
 *      so e2e tests can poke the dispatcher without going through
 *      the broader system endpoint).
 */
import { Router } from "express";

import type { GpuDispatcher } from "../../gpu/gpu-dispatcher.js";
import type { AuditLogger } from "../../logging/audit-logger.js";

export interface GpuDispatcherAdminDeps {
  dispatcher: GpuDispatcher;
  auditLogger?: AuditLogger;
}

function parseIndex(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return null;
  return n;
}

export function createGpuDispatcherAdminRouter(
  deps: GpuDispatcherAdminDeps,
): Router {
  const router = Router();
  const { dispatcher, auditLogger } = deps;

  router.get("/", (_req, res) => {
    res.json({ gpus: dispatcher.state() });
  });

  router.post("/:gpuIndex/cancel", (req, res) => {
    const idx = parseIndex(req.params.gpuIndex);
    if (idx === null) {
      res.status(400).json({ error: "invalid gpu index" });
      return;
    }
    const lane = dispatcher.laneState(idx);
    if (!lane) {
      res.status(404).json({ cancelled: false, reason: "no such lane" });
      return;
    }
    const cancelled = dispatcher.cancel(idx);
    void auditLogger?.log({
      level: cancelled ? "warn" : "info",
      category: "system",
      event: cancelled ? "gpu.manual_cancel" : "gpu.manual_cancel_noop",
      details: {
        gpuIndex: idx,
        jobId: lane.currentJob?.id,
        workloadType: lane.currentJob?.workloadType,
      },
    });
    res
      .status(cancelled ? 200 : 404)
      .json({ cancelled, lane: dispatcher.laneState(idx) });
  });

  router.post("/:gpuIndex/clear-error", (req, res) => {
    const idx = parseIndex(req.params.gpuIndex);
    if (idx === null) {
      res.status(400).json({ error: "invalid gpu index" });
      return;
    }
    const cleared = dispatcher.clearError(idx);
    void auditLogger?.log({
      level: "info",
      category: "system",
      event: "gpu.manual_clear_error",
      details: { gpuIndex: idx, cleared },
    });
    res
      .status(cleared ? 200 : 409)
      .json({ cleared, lane: dispatcher.laneState(idx) });
  });

  return router;
}
