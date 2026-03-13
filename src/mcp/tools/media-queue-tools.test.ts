import { describe, it, expect, vi } from "vitest";
import { createMediaQueueTools } from "./media-queue-tools.js";

vi.mock("../../queue/types.js", () => ({
  targetNodeForJobType: vi.fn().mockReturnValue("m2-pro"),
  defaultModelForJobType: vi.fn().mockReturnValue("flux-schnell"),
}));

function mockRepo() {
  return {
    createJob: vi.fn((input: Record<string, unknown>) => ({
      id: "job-1",
      type: input.type,
      status: "pending",
      requiredModel: input.model ?? "flux-schnell",
    })),
    getJob: vi.fn((id: string) =>
      id === "job-1"
        ? {
            id: "job-1",
            type: "txt2img",
            status: "completed",
            requiredModel: "flux-schnell",
            targetNode: "m2-pro",
            resultUrl: "/api/queue/assets/file/result.png",
            resultMetadata: { width: 512 },
            error: null,
            createdAt: new Date("2026-01-01"),
            completedAt: new Date("2026-01-01T00:01:00"),
          }
        : null,
    ),
  } as any;
}

function mockQueueMaster() {
  return {
    getNodeStatuses: vi.fn().mockResolvedValue([
      { node: "m2-pro", online: true, model: "flux-schnell" },
    ]),
  } as any;
}

describe("media-queue-tools", () => {
  it("returns two tool definitions", () => {
    const tools = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: mockQueueMaster() });
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("submit-media-job");
    expect(tools[1].name).toBe("get-job-status");
  });

  describe("submit-media-job", () => {
    it("submits a txt2img job", async () => {
      const repo = mockRepo();
      const [submitTool] = createMediaQueueTools({ mediaQueueRepo: repo, queueMaster: mockQueueMaster() });
      const result = await submitTool.handler({ type: "txt2img", prompt: "a cat" });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.job_id).toBe("job-1");
      expect(parsed.status).toBe("pending");
      expect(repo.createJob).toHaveBeenCalled();
    });

    it("accepts optional parameters", async () => {
      const repo = mockRepo();
      const [submitTool] = createMediaQueueTools({ mediaQueueRepo: repo, queueMaster: mockQueueMaster() });
      await submitTool.handler({
        type: "txt2img",
        prompt: "cat",
        width: 1024,
        height: 1024,
        steps: 20,
        guidance: 7.5,
        seed: 42,
        priority: 5,
        project_id: "proj-1",
      });
      const call = repo.createJob.mock.calls[0][0];
      expect(call.payload.width).toBe(1024);
      expect(call.priority).toBe(5);
      expect(call.projectId).toBe("proj-1");
    });

    it("submits music job with lyrics", async () => {
      const repo = mockRepo();
      const [submitTool] = createMediaQueueTools({ mediaQueueRepo: repo, queueMaster: mockQueueMaster() });
      await submitTool.handler({
        type: "txt2music",
        prompt: "rock song",
        duration_seconds: 30,
        lyrics: "Hello world",
        instrumental: false,
      });
      const call = repo.createJob.mock.calls[0][0];
      expect(call.payload.duration_seconds).toBe(30);
      expect(call.payload.lyrics).toBe("Hello world");
    });

    it("returns error on invalid args", async () => {
      const [submitTool] = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: mockQueueMaster() });
      const result = await submitTool.handler({ type: "invalid_type" });
      expect(result.isError).toBe(true);
    });

    it("returns error when repo throws", async () => {
      const repo = mockRepo();
      repo.createJob.mockImplementation(() => { throw new Error("DB full"); });
      const [submitTool] = createMediaQueueTools({ mediaQueueRepo: repo, queueMaster: mockQueueMaster() });
      const result = await submitTool.handler({ type: "txt2img", prompt: "cat" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("DB full");
    });
  });

  describe("get-job-status", () => {
    it("returns job info", async () => {
      const tools = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: mockQueueMaster() });
      const statusTool = tools[1];
      const result = await statusTool.handler({ job_id: "job-1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.job.status).toBe("completed");
      expect(parsed.job.result_url).toContain("result.png");
    });

    it("returns error for missing job", async () => {
      const tools = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: mockQueueMaster() });
      const statusTool = tools[1];
      const result = await statusTool.handler({ job_id: "missing" });
      expect(result.isError).toBe(true);
    });

    it("includes node status when requested", async () => {
      const qm = mockQueueMaster();
      const tools = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: qm });
      const statusTool = tools[1];
      const result = await statusTool.handler({ include_node_status: true });
      const parsed = JSON.parse(result.text);
      expect(parsed.nodes).toHaveLength(1);
      expect(qm.getNodeStatuses).toHaveBeenCalled();
    });

    it("returns both job and nodes", async () => {
      const tools = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: mockQueueMaster() });
      const statusTool = tools[1];
      const result = await statusTool.handler({ job_id: "job-1", include_node_status: true });
      const parsed = JSON.parse(result.text);
      expect(parsed.job).toBeDefined();
      expect(parsed.nodes).toBeDefined();
    });

    it("returns error on invalid args", async () => {
      const tools = createMediaQueueTools({ mediaQueueRepo: mockRepo(), queueMaster: mockQueueMaster() });
      const statusTool = tools[1];
      const result = await statusTool.handler({ job_id: 123 });
      expect(result.isError).toBe(true);
    });
  });
});
