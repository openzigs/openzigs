import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import { GpuDispatcher } from "../../gpu/gpu-dispatcher.js";
import { createGpuDispatcherAdminRouter } from "./gpu-dispatcher.js";

const buildApp = (dispatcher: GpuDispatcher) => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/gpu/dispatcher",
    createGpuDispatcherAdminRouter({ dispatcher }),
  );
  return app;
};

describe("createGpuDispatcherAdminRouter", () => {
  let dispatcher: GpuDispatcher;

  beforeEach(() => {
    dispatcher = new GpuDispatcher({ gpuCount: 2 });
  });

  it("GET / returns the lane snapshot for every GPU", async () => {
    const app = buildApp(dispatcher);
    const res = await request(app).get("/api/admin/gpu/dispatcher");
    expect(res.status).toBe(200);
    expect(res.body.gpus).toHaveLength(2);
    expect(res.body.gpus[0]).toMatchObject({ index: 0, state: "idle" });
    expect(res.body.gpus[1]).toMatchObject({ index: 1, state: "idle" });
  });

  it("POST /:gpuIndex/cancel cancels the running job and returns 200", async () => {
    const app = buildApp(dispatcher);
    const job = dispatcher.enqueue({
      workloadType: "image",
      run: async (_g, signal) =>
        new Promise<void>((_res, rej) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            rej(err);
          });
        }),
    });
    // Attach a swallowing handler immediately so the underlying rejection
    // does not surface as an unhandled-rejection during the brief window
    // between abort firing and the assertion below awaiting the same promise.
    const settled = job.catch(() => "rejected");
    await new Promise<void>((r) => setImmediate(r));

    const res = await request(app).post("/api/admin/gpu/dispatcher/1/cancel");
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    await expect(settled).resolves.toBe("rejected");
  });

  it("POST /:gpuIndex/cancel returns 404 with cancelled:false when lane is idle", async () => {
    const app = buildApp(dispatcher);
    const res = await request(app).post("/api/admin/gpu/dispatcher/0/cancel");
    expect(res.status).toBe(404);
    expect(res.body.cancelled).toBe(false);
  });

  it("POST /:gpuIndex/cancel returns 400 on a malformed index", async () => {
    const app = buildApp(dispatcher);
    const res = await request(app).post(
      "/api/admin/gpu/dispatcher/notanumber/cancel",
    );
    expect(res.status).toBe(400);
  });

  it("POST /:gpuIndex/cancel returns 404 when the lane index doesn't exist", async () => {
    const app = buildApp(dispatcher);
    const res = await request(app).post("/api/admin/gpu/dispatcher/99/cancel");
    expect(res.status).toBe(404);
  });

  it("POST /:gpuIndex/clear-error returns 200 after a poisoned lane is cleared", async () => {
    await expect(
      dispatcher.enqueue({
        workloadType: "image",
        run: async () => {
          throw new Error("kaboom");
        },
      }),
    ).rejects.toThrow();
    expect(dispatcher.laneState(1)?.state).toBe("error");

    const app = buildApp(dispatcher);
    const res = await request(app).post(
      "/api/admin/gpu/dispatcher/1/clear-error",
    );
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(dispatcher.laneState(1)?.state).toBe("idle");
  });

  it("POST /:gpuIndex/clear-error returns 409 when the lane is already healthy", async () => {
    const app = buildApp(dispatcher);
    const res = await request(app).post(
      "/api/admin/gpu/dispatcher/0/clear-error",
    );
    expect(res.status).toBe(409);
    expect(res.body.cleared).toBe(false);
  });
});
