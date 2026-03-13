import { describe, it, expect, vi } from "vitest";
import { createRemixTools } from "./remix-tools.js";

function mockRepo() {
  const jobs = new Map<string, Record<string, unknown>>();
  return {
    getAsset: vi.fn((id: string) =>
      id === "audio-1" ? { id: "audio-1", type: "audio", filename: "song.wav" } : null,
    ),
    getJob: vi.fn((id: string) => jobs.get(id) ?? null),
    createJob: vi.fn((input: Record<string, unknown>) => {
      const id = `job-${jobs.size + 1}`;
      const job = { id, ...input, status: "pending" };
      jobs.set(id, job);
      return job;
    }),
    _jobs: jobs,
  } as any;
}

describe("remix-tools", () => {
  it("returns one tool definition", () => {
    const tools = createRemixTools({ mediaQueueRepo: mockRepo() });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("remix-session-manager");
  });

  describe("analyze action", () => {
    it("submits analyze job", async () => {
      const repo = mockRepo();
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({ action: "analyze", source_audio_asset_id: "audio-1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.action).toBe("analyze");
      expect(parsed.job_id).toBeDefined();
    });

    it("errors when asset_id missing", async () => {
      const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
      const result = await tool.handler({ action: "analyze" });
      expect(result.isError).toBe(true);
    });

    it("errors when asset not found", async () => {
      const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
      const result = await tool.handler({ action: "analyze", source_audio_asset_id: "missing" });
      expect(result.isError).toBe(true);
    });
  });

  describe("replace_stem action", () => {
    it("errors when analyze_job_id missing", async () => {
      const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
      const result = await tool.handler({ action: "replace_stem", stem_name: "drums", target_instrument: "piano" });
      expect(result.isError).toBe(true);
    });

    it("errors when stem_name or target_instrument missing", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", { id: "j1", status: "complete", resultMetadata: { stems: {} } });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({ action: "replace_stem", analyze_job_id: "j1" });
      expect(result.isError).toBe(true);
    });

    it("errors when analyze job not complete", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", { id: "j1", status: "processing", resultMetadata: {} });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({
        action: "replace_stem", analyze_job_id: "j1", stem_name: "drums", target_instrument: "piano",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("processing");
    });

    it("errors when stem not found in results", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", { id: "j1", status: "complete", resultMetadata: { stems: { vocals: "/v.wav" } } });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({
        action: "replace_stem", analyze_job_id: "j1", stem_name: "drums", target_instrument: "piano",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found");
    });

    it("submits replace job when valid", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", {
        id: "j1", status: "complete",
        resultMetadata: { stems: { drums: "/drums.wav" }, bpm: 120, key: "C" },
      });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({
        action: "replace_stem", analyze_job_id: "j1", stem_name: "drums", target_instrument: "piano",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.action).toBe("replace_stem");
      expect(parsed.stem).toBe("drums");
    });
  });

  describe("master action", () => {
    it("errors when analyze_job_id missing", async () => {
      const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
      const result = await tool.handler({ action: "master" });
      expect(result.isError).toBe(true);
    });

    it("errors when analyze job not complete", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", { id: "j1", status: "processing" });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({ action: "master", analyze_job_id: "j1" });
      expect(result.isError).toBe(true);
    });

    it("submits master job", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", {
        id: "j1", status: "complete",
        resultMetadata: { stems: { vocals: "/v.wav", drums: "/d.wav" } },
      });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({ action: "master", analyze_job_id: "j1", vibe: "warm_lofi" });
      const parsed = JSON.parse(result.text);
      expect(parsed.action).toBe("master");
      expect(parsed.vibe).toBe("warm_lofi");
    });
  });

  describe("get_session action", () => {
    it("errors when analyze_job_id missing", async () => {
      const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
      const result = await tool.handler({ action: "get_session" });
      expect(result.isError).toBe(true);
    });

    it("returns job info", async () => {
      const repo = mockRepo();
      repo._jobs.set("j1", { id: "j1", status: "complete", resultMetadata: { bpm: 120 }, error: null });
      const [tool] = createRemixTools({ mediaQueueRepo: repo });
      const result = await tool.handler({ action: "get_session", analyze_job_id: "j1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.analyze_job.status).toBe("complete");
    });

    it("returns error when job not found", async () => {
      const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
      const result = await tool.handler({ action: "get_session", analyze_job_id: "missing" });
      expect(result.isError).toBe(true);
    });
  });

  it("returns error for invalid args", async () => {
    const [tool] = createRemixTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({ action: 999 });
    expect(result.isError).toBe(true);
  });
});
