/**
 * Admin router: /api/admin/gpu/vllm/*
 *
 * Issue #922 (Epic #888). Three endpoints:
 *   GET  /status — current vLLM container status + parsed Prometheus metrics
 *   POST /start  — register the GPU claim, then `docker compose up -d`
 *   POST /stop   — `docker compose stop` (SIGTERM, never SIGKILL) + unregister
 *
 * Deliberately NOT in `src/api/admin.ts` per repo convention to keep that
 * file from growing further. Mounted in `src/server.ts` at
 * `/api/admin/gpu/vllm`.
 *
 * Security guardrails:
 *   - Model id is validated against `VLLM_ALLOWED_MODELS` (Issue #922 spec).
 *   - The start endpoint is rate-limited to 1 request per 60 s per process.
 *   - `docker compose` is invoked via `spawn` with an argv array — never via
 *     `exec` with a shell — so the model id cannot inject shell metachars
 *     even if a future allowlist entry contains a `;`.
 *   - The 409 conflict body returns workload names + GPU indices only;
 *     never host paths, PIDs, or model file locations.
 */

import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  validateModelId,
  VLLM_ALLOWED_MODELS,
  DEFAULT_VLLM_MODEL,
} from "../../llm/vllm-models.js";
import type { GpuClaim, GpuCoordinator } from "../../gpu/gpu-coordinator.js";

export interface VllmAdminDeps {
  coordinator: GpuCoordinator;
  /** Resolves the docker-compose.vllm.yml path. Override in tests. */
  composeFilePath?: string;
  /** Override for tests — defaults to spawn(). */
  spawnImpl?: typeof spawn;
  /** Override for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests — defaults to Date.now. */
  now?: () => number;
  /** vLLM base URL the backend probes. */
  vllmBaseUrl?: string;
}

interface StartBody {
  model?: unknown;
}

interface ParsedPromMetric {
  name: string;
  value: number;
  labels: Record<string, string>;
}

const RATE_LIMIT_MS = 60_000;

export function createVllmAdminRouter(deps: VllmAdminDeps): Router {
  const router = Router();
  const composeFile =
    deps.composeFilePath ??
    path.join(process.cwd(), "docker-compose.vllm.yml");
  const doSpawn = deps.spawnImpl ?? spawn;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const vllmBaseUrl = (deps.vllmBaseUrl ?? "http://127.0.0.1:8000").replace(
    /\/+$/,
    "",
  );

  let lastStartAt = 0;

  router.get("/status", async (_req: Request, res: Response) => {
    const claims = deps.coordinator.currentClaims();
    const vllmClaim = claims.find((c: GpuClaim) => c.workload === "vllm");
    let modelInfo: { id?: string; reachable: boolean } = { reachable: false };
    let metrics: ParsedPromMetric[] = [];
    try {
      const modelsResp = await doFetch(`${vllmBaseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (modelsResp.ok) {
        const json = (await modelsResp.json()) as {
          data?: Array<{ id?: string }>;
        };
        modelInfo = { id: json.data?.[0]?.id, reachable: true };
      }
      const metricsResp = await doFetch(`${vllmBaseUrl}/metrics`, {
        signal: AbortSignal.timeout(2000),
      });
      if (metricsResp.ok) {
        metrics = parsePrometheus(await metricsResp.text());
      }
    } catch {
      // Sidecar unreachable — return whatever we have without 5xx.
    }
    res.json({
      claim: vllmClaim ?? null,
      reachable: modelInfo.reachable,
      model: modelInfo.id ?? null,
      metrics,
      allowedModels: VLLM_ALLOWED_MODELS,
      defaultModel: DEFAULT_VLLM_MODEL,
    });
  });

  router.post("/start", async (req: Request, res: Response) => {
    const ts = now();
    if (ts - lastStartAt < RATE_LIMIT_MS) {
      const retryAfter = Math.ceil(
        (RATE_LIMIT_MS - (ts - lastStartAt)) / 1000,
      );
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "rate_limited",
        message: `vLLM start is rate-limited; try again in ${retryAfter}s`,
      });
    }
    const body = (req.body ?? {}) as StartBody;
    const modelInput = typeof body.model === "string" ? body.model : DEFAULT_VLLM_MODEL;
    const valid = validateModelId(modelInput);
    if (!valid.ok) {
      return res
        .status(400)
        .json({ error: "invalid_model", message: valid.reason });
    }
    // Coordinator first — refuse to spawn docker if a conflicting workload
    // (FLUX, LTX, etc.) holds GPUs we need.
    const reg = deps.coordinator.register("vllm", [0, 1]);
    if (!reg.ok) {
      return res.status(409).json({
        error: "gpu_conflict",
        conflictWith: reg.conflictWith,
        gpus: reg.conflictGpus,
        message: `vLLM requires exclusive GPUs ${reg.conflictGpus.join(",")} but ${reg.conflictWith} already holds them`,
      });
    }
    lastStartAt = ts;
    try {
      await runDockerCompose(
        doSpawn,
        ["compose", "-f", composeFile, "up", "-d"],
        { VLLM_MODEL: valid.entry.id },
      );
      return res.json({
        ok: true,
        model: valid.entry.id,
        message: "vLLM start issued; first cold start may take 3-5 minutes",
      });
    } catch (err) {
      // Roll back the GPU claim — vLLM never came up.
      deps.coordinator.unregister("vllm");
      return res.status(500).json({
        error: "docker_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/stop", async (_req: Request, res: Response) => {
    try {
      // `compose stop` sends SIGTERM with a 10s grace period (configurable).
      // Never use `kill` (SIGKILL) — vLLM needs a clean shutdown to release
      // its CUDA context, otherwise the next start fails with "OOM at init".
      await runDockerCompose(doSpawn, ["compose", "-f", composeFile, "stop"], {});
      deps.coordinator.unregister("vllm");
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        error: "docker_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}

/**
 * Tiny Prometheus exposition-format parser. Sufficient for vLLM's exported
 * metrics (`vllm:num_requests_running`, `vllm:gpu_cache_usage_perc`, etc.).
 * Pull a real parser if/when we expose more series.
 */
export function parsePrometheus(body: string): ParsedPromMetric[] {
  const out: ParsedPromMetric[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // sample: vllm:gpu_cache_usage_perc{model_name="Qwen/Qwen2.5-14B-Instruct-AWQ"} 0.234
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (!m) continue;
    const [, name, labelBlock, valueStr] = m;
    const value = Number(valueStr);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (labelBlock) {
      const labelStr = labelBlock.slice(1, -1);
      for (const pair of labelStr.split(",")) {
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim().replace(/^"|"$/g, "");
        labels[k] = v;
      }
    }
    out.push({ name, value, labels });
  }
  return out;
}

function runDockerCompose(
  spawnImpl: typeof spawn,
  args: string[],
  envOverrides: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("docker", args, {
      env: { ...process.env, ...envOverrides },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose exited with code ${code}`));
    });
  });
}
