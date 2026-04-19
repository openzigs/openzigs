import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMediaQueueTools } from "../media-queue-tools.js";

describe("Tier 2: submit-media-job handler", () => {
  const mockRepo = {
    createJob: vi.fn().mockReturnValue({
      id: "job-123",
      type: "txt2img",
      status: "pending",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
    }),
  };
  const mockQM = {
    getNodeStatuses: vi.fn().mockResolvedValue([
      { node: "image-gen", reachable: true, is_busy: false },
    ]),
  };

  let submitHandler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tools = createMediaQueueTools({
      mediaQueueRepo: mockRepo as never,
      queueMaster: mockQM as never,
    });
    submitHandler = tools.find((t) => t.name === "submit-media-job")!.handler;
  });

  it("submits a valid txt2img job", async () => {
    const result = await submitHandler({ type: "txt2img", prompt: "a sunset" });
    expect(mockRepo.createJob).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.job_id).toBe("job-123");
    expect(parsed.status).toBe("pending");
  });

  it("auto-selects model when not provided", async () => {
    await submitHandler({ type: "txt2video", prompt: "test" });
    const call = mockRepo.createJob.mock.calls[0][0];
    expect(call.model).toBe("ltx-2");
  });

  it("rejects invalid job type", async () => {
    const result = await submitHandler({ type: "invalid_type" });
    expect(result.isError).toBe(true);
  });

  it("includes project_id when provided", async () => {
    await submitHandler({ type: "txt2img", prompt: "test", project_id: "proj-1" });
    const call = mockRepo.createJob.mock.calls[0][0];
    expect(call.projectId).toBe("proj-1");
  });
});

describe("Tier 2: get-job-status handler", () => {
  const mockRepo = {
    getJob: vi.fn().mockReturnValue({
      id: "job-123",
      type: "txt2img",
      status: "complete",
      requiredModel: "flux-schnell",
      targetNode: "image-gen",
      resultUrl: "/api/queue/assets/file/job-123.png",
      resultMetadata: null,
      error: null,
      createdAt: new Date("2026-03-04"),
      completedAt: new Date("2026-03-04"),
    }),
  };
  const mockQM = {
    getNodeStatuses: vi.fn().mockResolvedValue([
      { node: "image-gen", reachable: true, is_busy: false, loaded_model: "flux-schnell" },
    ]),
  };

  let handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tools = createMediaQueueTools({
      mediaQueueRepo: mockRepo as never,
      queueMaster: mockQM as never,
    });
    handler = tools.find((t) => t.name === "get-job-status")!.handler;
  });

  it("returns job status by id", async () => {
    const result = await handler({ job_id: "job-123" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.job.status).toBe("complete");
  });

  it("returns error for missing job", async () => {
    mockRepo.getJob.mockReturnValueOnce(null);
    const result = await handler({ job_id: "nonexistent" });
    expect(result.isError).toBe(true);
  });

  it("returns node status when requested", async () => {
    const result = await handler({ include_node_status: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.nodes).toHaveLength(1);
  });
});
