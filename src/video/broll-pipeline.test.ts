/**
 * B-Roll Pipeline — Unit Tests
 * Issue #822: Auto B-Roll Insertion.
 */

import { describe, it, expect, vi } from "vitest";
import { BRollPipeline, type BRollChatFn } from "./broll-pipeline.js";

function createMockChat(response: string): BRollChatFn {
  return async function* mockChat() {
    yield response;
  };
}

describe("BRollPipeline", () => {
  it("creates a job and assigns an ID", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    vi.spyOn(pipeline as never, "runPipeline" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await pipeline.submit({
      source: "/tmp/test.mp4",
      mode: "suggest",
    });
    expect(id).toMatch(/^broll-/);
    expect(pipeline.getJob(id)).toBeDefined();
  });

  it("lists all jobs", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    vi.spyOn(pipeline as never, "runPipeline" as never).mockResolvedValue(
      undefined as never,
    );

    await pipeline.submit({ source: "/tmp/a.mp4", mode: "suggest" });
    expect(pipeline.listJobs().length).toBeGreaterThanOrEqual(1);
  });

  it("emits broll:queued on submit", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    vi.spyOn(pipeline as never, "runPipeline" as never).mockResolvedValue(
      undefined as never,
    );

    const handler = vi.fn();
    pipeline.on("broll:queued", handler);

    await pipeline.submit({ source: "/tmp/test.mp4", mode: "suggest" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: expect.stringMatching(/^broll-/) }),
    );
  });

  it("emits broll:complete on success", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(pipeline as any, "runPipeline").mockImplementation(
      async (job: any) => {
        job.suggestions = [
          {
            timestamp: 30,
            duration: 5,
            query: "city skyline",
            context: "establishing shot",
            source: "stock",
            score: 0.8,
          },
        ];
      },
    );

    const handler = vi.fn();
    pipeline.on("broll:complete", handler);

    const id = await pipeline.submit({
      source: "/tmp/test.mp4",
      mode: "suggest",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: id,
        suggestions: expect.arrayContaining([
          expect.objectContaining({ query: "city skyline" }),
        ]),
      }),
    );
  });

  it("emits broll:failed on error", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    vi.spyOn(pipeline as never, "runPipeline" as never).mockRejectedValue(
      new Error("Test error"),
    );

    const handler = vi.fn();
    pipeline.on("broll:failed", handler);

    const id = await pipeline.submit({
      source: "/tmp/test.mp4",
      mode: "suggest",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id, error: "Test error" }),
    );
  });

  it("waitForCompletion resolves on success", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    vi.spyOn(pipeline as never, "runPipeline" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await pipeline.submit({
      source: "/tmp/test.mp4",
      mode: "suggest",
    });
    const job = await pipeline.waitForCompletion(id, 5000);
    expect(job.status).toBe("complete");
  });

  it("waitForCompletion rejects for unknown job", async () => {
    const pipeline = new BRollPipeline({
      chat: createMockChat("[]"),
    });
    await expect(pipeline.waitForCompletion("nonexistent")).rejects.toThrow(
      "not found",
    );
  });
});
