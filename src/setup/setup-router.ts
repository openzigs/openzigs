/**
 * Express router for the Onboarding Wizard 2.0 (epic #1118).
 *
 * Mounted at `/api/admin/setup`. All routes go through `authMiddleware`
 * applied by the host (see `src/server.ts`).
 *
 * Sub-issues:
 *   #1126 — GET/POST /state, POST /state/reset
 *   #1159 — GET /sidecars, POST /sidecars/:name/install (SSE)
 *   #1162 — GET /social, POST /social/:platform/manual-token,
 *           GET /credentials, DELETE /credentials/:platform
 *   #1118 — POST /byok/test
 *   #1140 — GET /recipes, POST /recipes/:id/import
 */

import { Router, type Request, type Response } from "express";
import {
  SidecarInstaller,
  SIDECAR_NAMES,
  type SidecarName,
} from "./sidecar-installer.js";
import { SOCIAL_PLATFORMS, findPlatform } from "./social-oauth-catalog.js";
import {
  ByokTester,
  BYOK_PROVIDERS,
  type ByokProvider,
} from "./byok-tester.js";
import { StarterRecipeLoader } from "./starter-recipe-loader.js";
import type {
  SetupStateRepository,
  WizardStepId,
} from "./setup-state-repository.js";
import type { WizardCredentialStore } from "./wizard-credential-store.js";
import type { TemplateService } from "../productivity/template-service.js";

const VALID_STEPS: WizardStepId[] = [
  "welcome",
  "prereqs",
  "sidecars",
  "social",
  "byok",
  "recipes",
  "complete",
];

export interface SetupRouterDeps {
  stateRepo: SetupStateRepository;
  credentialStore: WizardCredentialStore;
  templateService: TemplateService;
  sidecarInstaller?: SidecarInstaller;
  recipeLoader?: StarterRecipeLoader;
  byokTester?: ByokTester;
}

export function createSetupRouter(deps: SetupRouterDeps): Router {
  const router = Router();
  const sidecarInstaller = deps.sidecarInstaller ?? new SidecarInstaller();
  const recipeLoader = deps.recipeLoader ?? new StarterRecipeLoader();
  const byokTester = deps.byokTester ?? new ByokTester();

  // ── State ────────────────────────────────────────────────────────

  router.get("/state", (_req, res) => {
    return res.json(deps.stateRepo.get());
  });

  router.post("/state", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Parameters<typeof deps.stateRepo.save>[0] = {};

    if (typeof body.currentStep === "string") {
      if (!VALID_STEPS.includes(body.currentStep as WizardStepId)) {
        return res.status(400).json({ error: "invalid currentStep" });
      }
      updates.currentStep = body.currentStep as WizardStepId;
    }
    if (Array.isArray(body.completedSteps)) {
      const sanitized = body.completedSteps.filter(
        (s): s is WizardStepId =>
          typeof s === "string" && VALID_STEPS.includes(s as WizardStepId),
      );
      updates.completedSteps = sanitized;
    }
    if (body.data && typeof body.data === "object") {
      updates.data = body.data as Record<string, unknown>;
    }

    return res.json(deps.stateRepo.save(updates));
  });

  router.post("/state/reset", (_req, res) => {
    deps.stateRepo.reset();
    return res.json({ ok: true });
  });

  // ── Sidecars ─────────────────────────────────────────────────────

  router.get("/sidecars", async (_req, res) => {
    const statuses = await sidecarInstaller.listStatus();
    const installer = sidecarInstaller.installScript();
    return res.json({
      sidecars: statuses,
      installScript: installer.script,
      supported: installer.supported,
    });
  });

  router.post("/sidecars/:name/install", async (req, res) => {
    const name = req.params.name;
    if (!(SIDECAR_NAMES as readonly string[]).includes(name)) {
      res.status(400).json({ error: "unknown sidecar" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const evt of sidecarInstaller.streamInstall(
        name as SidecarName,
      )) {
        send(evt.kind, evt);
        if (evt.kind === "done") break;
      }
    } catch (err: unknown) {
      const e = err as Error | undefined;
      const message = e?.message ?? String(err);
      send("error", { kind: "error", message });
    } finally {
      res.end();
    }
  });

  // ── Social OAuth catalog ─────────────────────────────────────────

  router.get("/social", async (_req, res) => {
    const credentials = await deps.credentialStore.listCredentials();
    const platforms = SOCIAL_PLATFORMS.map((p) => ({
      ...p,
      connected: credentials.some((c) => c.platform === p.id),
      connectedAt:
        credentials.find((c) => c.platform === p.id)?.updatedAt ?? null,
    }));
    return res.json({ platforms });
  });

  router.post("/social/:platform/manual-token", async (req, res) => {
    const id = req.params.platform;
    const platform = findPlatform(id);
    if (!platform) return res.status(404).json({ error: "unknown platform" });
    if (platform.authMode !== "manual_token") {
      return res
        .status(400)
        .json({ error: `${id} requires OAuth, not a manual token` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token.length === 0) {
      return res.status(400).json({ error: "token is required" });
    }
    const meta = await deps.credentialStore.setCredential(
      platform.id,
      "access_token",
      token,
    );
    return res.json({ ok: true, credential: meta });
  });

  router.get("/credentials", async (_req, res) => {
    return res.json({
      credentials: await deps.credentialStore.listCredentials(),
    });
  });

  router.delete("/credentials/:platform", async (req, res) => {
    const id = req.params.platform;
    if (!findPlatform(id)) {
      return res.status(404).json({ error: "unknown platform" });
    }
    const removed = await deps.credentialStore.deletePlatform(id);
    return res.json({ ok: true, removed });
  });

  // ── BYOK testing ─────────────────────────────────────────────────

  router.post("/byok/test", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = body.provider;
    const apiKey = body.apiKey;
    if (
      typeof provider !== "string" ||
      !BYOK_PROVIDERS.includes(provider as ByokProvider)
    ) {
      return res.status(400).json({
        error: `provider must be one of ${BYOK_PROVIDERS.join(", ")}`,
      });
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return res.status(400).json({ error: "apiKey is required" });
    }
    const result = await byokTester.test(provider as ByokProvider, apiKey);
    return res.json(result);
  });

  router.post("/byok/save", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = body.provider;
    const apiKey = body.apiKey;
    if (
      typeof provider !== "string" ||
      !BYOK_PROVIDERS.includes(provider as ByokProvider)
    ) {
      return res.status(400).json({ error: "invalid provider" });
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return res.status(400).json({ error: "apiKey is required" });
    }
    const meta = await deps.credentialStore.setCredential(
      `byok-${provider}`,
      "api_key",
      apiKey.trim(),
    );
    return res.json({ ok: true, credential: meta });
  });

  // ── Starter recipes ──────────────────────────────────────────────

  router.get("/recipes", async (_req, res) => {
    return res.json({ recipes: await recipeLoader.list() });
  });

  router.post("/recipes/:id/import", async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!/^[a-z0-9-]{1,80}$/.test(id)) {
      return res.status(400).json({ error: "invalid recipe id" });
    }
    const recipe = await recipeLoader.get(id);
    if (!recipe) return res.status(404).json({ error: "recipe not found" });

    try {
      const saved = deps.templateService.import(recipe, {});
      return res.json({ ok: true, promptId: saved.id, name: saved.name });
    } catch (err: unknown) {
      const e = err as Error | undefined;
      const message = e?.message ?? String(err);
      return res.status(400).json({ error: message });
    }
  });

  return router;
}
