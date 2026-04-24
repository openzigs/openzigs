import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchV2aJob, v2aHealthCheck } from "./v2a-client.js";

describe("dispatchV2aJob (WS1-A #925)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("posts a videoPath job to /generate and returns 'accepted' on 202", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted", job_id: "j1" }), {
        status: 202,
      }),
    );

    const result = await dispatchV2aJob(
      {
        jobId: "j1",
        videoPath: "/tmp/silent.mp4",
        durationSec: 8.0,
        prompt: "ocean waves",
      },
      { baseUrl: "http://localhost:5012", fetchImpl: fetchMock },
    );

    expect(result).toEqual({ status: "accepted", jobId: "j1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5012/generate");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.job_id).toBe("j1");
    expect(body.video_path).toBe("/tmp/silent.mp4");
    expect(body.duration_sec).toBe(8.0);
    expect(body.prompt).toBe("ocean waves");
  });

  it("includes Authorization header when token is provided", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await dispatchV2aJob(
      { jobId: "j1", videoPath: "/x.mp4", durationSec: 4 },
      { fetchImpl: fetchMock, token: "secret123" },
    );
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret123");
  });

  it("skips when neither videoPath nor videoB64 is provided", async () => {
    const result = await dispatchV2aJob(
      { jobId: "j1", durationSec: 8 },
      { fetchImpl: fetchMock },
    );
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/Neither/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when both videoPath and videoB64 are provided", async () => {
    const result = await dispatchV2aJob(
      {
        jobId: "j1",
        videoPath: "/x.mp4",
        videoB64: "AAAA",
        durationSec: 8,
      },
      { fetchImpl: fetchMock },
    );
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/exactly one/);
  });

  it("skips when durationSec is non-positive or non-finite", async () => {
    for (const d of [0, -1, NaN, Infinity]) {
      const result = await dispatchV2aJob(
        { jobId: "j1", videoPath: "/x.mp4", durationSec: d },
        { fetchImpl: fetchMock },
      );
      expect(result.status).toBe("skipped");
    }
  });

  it("returns 'failed' with status text on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      new Response("model not loaded", { status: 503, statusText: "Service Unavailable" }),
    );
    const result = await dispatchV2aJob(
      { jobId: "j1", videoPath: "/x.mp4", durationSec: 8 },
      { fetchImpl: fetchMock },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/503/);
  });

  it("returns 'failed' when fetch throws (network error / timeout)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await dispatchV2aJob(
      { jobId: "j1", videoPath: "/x.mp4", durationSec: 8 },
      { fetchImpl: fetchMock },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("ECONNREFUSED");
  });
});

describe("v2aHealthCheck", () => {
  it("reports reachable=true when sidecar returns status='ok'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", loaded: true }), { status: 200 }),
    );
    const result = await v2aHealthCheck({ fetchImpl: fetchMock });
    expect(result).toEqual({ reachable: true, loaded: true });
  });

  it("reports reachable=false when sidecar returns 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const result = await v2aHealthCheck({ fetchImpl: fetchMock });
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it("reports reachable=false on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const result = await v2aHealthCheck({ fetchImpl: fetchMock });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe("ENOTFOUND");
  });
});
