import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createSetupRouter, type SetupRouterDeps } from "./setup-router.js";

const makeApp = (overrides: Partial<SetupRouterDeps> = {}) => {
  const state = {
    currentStep: "welcome" as string,
    completedSteps: [] as string[],
    data: {} as Record<string, unknown>,
    updatedAt: "2026-02-09T12:00:00.000Z",
  };
  const credentials: { platform: string; type: string; value: string }[] = [];

  const stateRepo = {
    get: () => state,
    save: (updates: Partial<typeof state>) => {
      Object.assign(state, updates);
      if (updates.data) state.data = { ...state.data, ...updates.data };
      return state;
    },
    reset: () => {
      state.currentStep = "welcome";
      state.completedSteps = [];
      state.data = {};
    },
  };

  const credentialStore = {
    setCredential: async (platform: string, type: string, value: string) => {
      credentials.push({ platform, type, value });
      return {
        platform,
        type,
        hasValue: true,
        updatedAt: "2026-02-09T12:00:00.000Z",
      };
    },
    getCredential: async (platform: string, type: string) =>
      credentials.find((c) => c.platform === platform && c.type === type)
        ?.value ?? null,
    listCredentials: async () =>
      credentials.map((c) => ({
        platform: c.platform,
        type: c.type,
        hasValue: true,
        updatedAt: "2026-02-09T12:00:00.000Z",
      })),
    listForPlatform: async (platform: string) =>
      credentials
        .filter((c) => c.platform === platform)
        .map((c) => ({
          platform: c.platform,
          type: c.type,
          hasValue: true,
          updatedAt: "2026-02-09T12:00:00.000Z",
        })),
    deletePlatform: async (platform: string) => {
      const before = credentials.length;
      for (let i = credentials.length - 1; i >= 0; i--) {
        if (credentials[i]!.platform === platform) credentials.splice(i, 1);
      }
      return before - credentials.length;
    },
    deleteCredential: async (platform: string, type: string) => {
      const idx = credentials.findIndex(
        (c) => c.platform === platform && c.type === type,
      );
      if (idx < 0) return false;
      credentials.splice(idx, 1);
      return true;
    },
  };

  const templateService = {
    import: (_data: unknown, _placeholders: Record<string, string>) => ({
      id: "imported-id-1",
      name: "imported-name",
    }),
  };

  const sidecarInstaller = {
    listStatus: async () => [
      {
        name: "audio",
        installed: false,
        hasServer: false,
        hasVenv: false,
        description: "x",
      },
    ],
    installScript: () => ({ script: "/tmp/install.sh", supported: true }),
    streamInstall: async function* () {
      yield { kind: "log", stream: "stdout", message: "hi" };
      yield { kind: "done", code: 0 };
    },
  };

  const recipeLoader = {
    list: async () => [
      {
        id: "director-first-video",
        name: "Director",
        description: "d",
        tags: ["starter"],
        stageCount: 3,
      },
    ],
    get: async (id: string) =>
      id === "director-first-video"
        ? ({ prompt: { name: "Director" } } as Record<string, unknown>)
        : null,
  };

  const byokTester = {
    test: async (provider: string, _apiKey: string) => ({
      provider,
      ok: true,
      latencyMs: 5,
      status: 200,
      message: "OK (200)",
    }),
  };

  const deps = {
    stateRepo,
    credentialStore,
    templateService,
    sidecarInstaller,
    recipeLoader,
    byokTester,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as SetupRouterDeps;

  const app = express();
  app.use(express.json());
  app.use("/api/admin/setup", createSetupRouter(deps));
  return { app, state, credentials, templateService };
};

describe("setup-router", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  // ── State ──
  it("GET /state returns current wizard state", async () => {
    const res = await request(ctx.app).get("/api/admin/setup/state");
    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe("welcome");
  });

  it("POST /state updates a valid currentStep", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/state")
      .send({ currentStep: "sidecars" });
    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe("sidecars");
  });

  it("POST /state rejects an invalid currentStep", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/state")
      .send({ currentStep: "bogus" });
    expect(res.status).toBe(400);
  });

  it("POST /state filters bogus completedSteps and merges data", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/state")
      .send({
        completedSteps: ["welcome", "bogus", "byok"],
        data: { x: 1 },
      });
    expect(res.status).toBe(200);
    expect(res.body.completedSteps).toEqual(["welcome", "byok"]);
    expect(res.body.data).toMatchObject({ x: 1 });
  });

  it("POST /state/reset clears state", async () => {
    await request(ctx.app)
      .post("/api/admin/setup/state")
      .send({ currentStep: "complete" });
    const res = await request(ctx.app).post("/api/admin/setup/state/reset");
    expect(res.status).toBe(200);
    expect(ctx.state.currentStep).toBe("welcome");
  });

  // ── Sidecars ──
  it("GET /sidecars lists sidecars + script", async () => {
    const res = await request(ctx.app).get("/api/admin/setup/sidecars");
    expect(res.status).toBe(200);
    expect(res.body.sidecars).toHaveLength(1);
    expect(res.body.supported).toBe(true);
  });

  it("POST /sidecars/:name/install rejects unknown sidecars", async () => {
    const res = await request(ctx.app).post(
      "/api/admin/setup/sidecars/bogus/install",
    );
    expect(res.status).toBe(400);
  });

  it("POST /sidecars/:name/install streams SSE events", async () => {
    const res = await request(ctx.app).post(
      "/api/admin/setup/sidecars/audio/install",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("event: log");
    expect(res.text).toContain("event: done");
  });

  // ── Social ──
  it("GET /social returns platforms with connection state", async () => {
    const res = await request(ctx.app).get("/api/admin/setup/social");
    expect(res.status).toBe(200);
    expect(res.body.platforms).toHaveLength(7);
    expect(
      res.body.platforms.every(
        (p: { connected: boolean }) => typeof p.connected === "boolean",
      ),
    ).toBe(true);
  });

  it("POST /social/tiktok/manual-token saves the token", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/social/tiktok/manual-token")
      .send({ token: "tok_abc" });
    expect(res.status).toBe(200);
    expect(ctx.credentials.find((c) => c.platform === "tiktok")?.value).toBe(
      "tok_abc",
    );
  });

  it("POST /social/meta/manual-token is rejected (oauth platform)", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/social/meta/manual-token")
      .send({ token: "x" });
    expect(res.status).toBe(400);
  });

  it("POST /social/unknown/manual-token returns 404", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/social/myspace/manual-token")
      .send({ token: "x" });
    expect(res.status).toBe(404);
  });

  it("POST /social/tiktok/manual-token rejects empty token", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/social/tiktok/manual-token")
      .send({ token: "   " });
    expect(res.status).toBe(400);
  });

  it("GET /credentials returns stored credentials", async () => {
    await request(ctx.app)
      .post("/api/admin/setup/social/tiktok/manual-token")
      .send({ token: "t" });
    const res = await request(ctx.app).get("/api/admin/setup/credentials");
    expect(res.status).toBe(200);
    expect(res.body.credentials).toHaveLength(1);
  });

  it("DELETE /credentials/:platform removes them", async () => {
    await request(ctx.app)
      .post("/api/admin/setup/social/tiktok/manual-token")
      .send({ token: "t" });
    const res = await request(ctx.app).delete(
      "/api/admin/setup/credentials/tiktok",
    );
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
  });

  it("DELETE /credentials/unknown returns 404", async () => {
    const res = await request(ctx.app).delete(
      "/api/admin/setup/credentials/myspace",
    );
    expect(res.status).toBe(404);
  });

  // ── BYOK ──
  it("POST /byok/test rejects unknown provider", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/byok/test")
      .send({ provider: "nope", apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("POST /byok/test rejects missing key", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/byok/test")
      .send({ provider: "openai", apiKey: "" });
    expect(res.status).toBe(400);
  });

  it("POST /byok/test returns tester result on happy path", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/byok/test")
      .send({ provider: "openai", apiKey: "sk" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /byok/save stores under byok-<provider>", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/byok/save")
      .send({ provider: "openai", apiKey: "sk-xyz" });
    expect(res.status).toBe(200);
    expect(
      ctx.credentials.find((c) => c.platform === "byok-openai")?.value,
    ).toBe("sk-xyz");
  });

  it("POST /byok/save rejects invalid provider", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/byok/save")
      .send({ provider: "nope", apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("POST /byok/save rejects missing key", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/setup/byok/save")
      .send({ provider: "openai" });
    expect(res.status).toBe(400);
  });

  // ── Recipes ──
  it("GET /recipes lists recipes", async () => {
    const res = await request(ctx.app).get("/api/admin/setup/recipes");
    expect(res.status).toBe(200);
    expect(res.body.recipes).toHaveLength(1);
  });

  it("POST /recipes/:id/import returns saved prompt", async () => {
    const res = await request(ctx.app).post(
      "/api/admin/setup/recipes/director-first-video/import",
    );
    expect(res.status).toBe(200);
    expect(res.body.promptId).toBe("imported-id-1");
  });

  it("POST /recipes/:id/import rejects invalid id", async () => {
    const res = await request(ctx.app).post(
      "/api/admin/setup/recipes/..%2Fevil/import",
    );
    expect(res.status).toBe(400);
  });

  it("POST /recipes/:id/import returns 404 for missing recipe", async () => {
    const res = await request(ctx.app).post(
      "/api/admin/setup/recipes/missing-id/import",
    );
    expect(res.status).toBe(404);
  });

  it("POST /recipes/:id/import surfaces template import errors as 400", async () => {
    const failingTemplate = {
      import: () => {
        throw new Error("invalid template");
      },
    };
    const failCtx = makeApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      templateService: failingTemplate as any,
    });
    const res = await request(failCtx.app).post(
      "/api/admin/setup/recipes/director-first-video/import",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid template/);
  });
});
