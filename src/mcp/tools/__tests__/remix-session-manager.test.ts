import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRemixTools } from "../remix-tools.js";

describe("Tier 2: remix-session-manager handler", () => {
  const mockRepo = {
    getAsset: vi.fn().mockReturnValue({
      id: "asset-1",
      file_path: "/gallery/track.mp3",
      type: "audio",
    }),
    getJob: vi.fn(),
    createJob: vi.fn().mockReturnValue({
      id: "remix-job-1",
      type: "remix_analyze",
      status: "pending",
    }),
  };

  let handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tools = createRemixTools({ mediaQueueRepo: mockRepo as never });
    handler = tools[0].handler;
  });

  it("starts analyze with valid asset", async () => {
    const result = await handler({ action: "analyze", source_audio_asset_id: "asset-1" });
    expect(mockRepo.getAsset).toHaveBeenCalledWith("asset-1");
    expect(mockRepo.createJob).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.action).toBe("analyze");
  });

  it("requires source_audio_asset_id for analyze", async () => {
    const result = await handler({ action: "analyze" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("source_audio_asset_id");
  });

  it("returns error when asset not found for analyze", async () => {
    mockRepo.getAsset.mockReturnValueOnce(null);
    const result = await handler({ action: "analyze", source_audio_asset_id: "bad-id" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  it("requires analyze_job_id for replace_stem", async () => {
    const result = await handler({ action: "replace_stem" });
    expect(result.isError).toBe(true);
  });

  it("requires completed analyze for replace_stem", async () => {
    mockRepo.getJob.mockReturnValueOnce({
      id: "analyze-1",
      status: "processing",
      resultMetadata: null,
    });
    const result = await handler({
      action: "replace_stem",
      analyze_job_id: "analyze-1",
      stem_name: "drums",
      target_instrument: "strings",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not complete");
  });

  it("replaces stem when analysis is complete", async () => {
    mockRepo.getJob.mockReturnValueOnce({
      id: "analyze-1",
      status: "complete",
      resultMetadata: {
        stems: { vocals: "/stems/v.wav", drums: "/stems/d.wav" },
        bpm: 120,
        key: "C major",
      },
    });
    mockRepo.createJob.mockReturnValueOnce({
      id: "replace-1",
      type: "remix_replace",
      status: "pending",
    });
    const result = await handler({
      action: "replace_stem",
      analyze_job_id: "analyze-1",
      stem_name: "drums",
      target_instrument: "strings",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.action).toBe("replace_stem");
    expect(parsed.stem).toBe("drums");
  });

  it("masters with vibe preset", async () => {
    mockRepo.getJob.mockReturnValueOnce({
      id: "analyze-1",
      status: "complete",
      resultMetadata: {
        stems: { vocals: "/stems/v.wav", drums: "/stems/d.wav" },
      },
    });
    mockRepo.createJob.mockReturnValueOnce({
      id: "master-1",
      type: "remix_master",
      status: "pending",
    });
    const result = await handler({
      action: "master",
      analyze_job_id: "analyze-1",
      vibe: "warm_lofi",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.vibe).toBe("warm_lofi");
  });

  it("gets session state", async () => {
    mockRepo.getJob.mockReturnValueOnce({
      id: "analyze-1",
      status: "complete",
      resultMetadata: { stems: {} },
      error: null,
    });
    const result = await handler({ action: "get_session", analyze_job_id: "analyze-1" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.analyze_job.status).toBe("complete");
  });
});
