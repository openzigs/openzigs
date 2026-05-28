import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createYouTubePublishTools } from "./youtube-publish-tools.js";
import type {
  ResumableFetch,
  ResumableFetchResponse,
} from "./youtube-resumable-upload.js";

const writeTempFile = async (bytes: number, ext = ".mp4"): Promise<string> => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "openzigs-yt-pub-"),
  );
  const file = path.join(dir, `clip${ext}`);
  await fsPromises.writeFile(file, Buffer.alloc(bytes, "a"));
  return file;
};

const buildHeaders = (h: Record<string, string>) => ({
  get: (name: string) => h[name] ?? h[name.toLowerCase()] ?? null,
});

const makeResumableResponse = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): ResumableFetchResponse => ({
  status,
  headers: buildHeaders(headers),
  text: async () => body,
});

const makeFetchResponse = (status: number, body: string): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  }) as unknown as Response;

describe("createYouTubePublishTools", () => {
  beforeEach(() => {
    delete process.env.YOUTUBE_OAUTH_TOKEN;
  });

  afterEach(() => {
    delete process.env.YOUTUBE_OAUTH_TOKEN;
  });

  describe("youtube-upload-video", () => {
    it("returns isError when no OAuth token is configured", async () => {
      const tools = createYouTubePublishTools();
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;

      const file = await writeTempFile(1024);
      const res = await upload.handler({ file_path: file, title: "T" });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.text) as {
        success: boolean;
        error: string;
      };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("YOUTUBE_OAUTH_TOKEN");
    });

    it("returns isError when the video file does not exist", async () => {
      const tools = createYouTubePublishTools({
        getAccessToken: () => "fake-token",
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;

      const res = await upload.handler({
        file_path: "/tmp/does-not-exist-xyz.mp4",
        title: "T",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("not found");
    });

    it("uploads via the injected fetch and returns {video_id, url}", async () => {
      const file = await writeTempFile(256 * 1024);
      const sessionUrl = "https://upload.example/session-pub";

      const fetchImpl: ResumableFetch = async (url) => {
        if (url.includes("uploadType=resumable")) {
          return makeResumableResponse(200, "", { Location: sessionUrl });
        }
        return makeResumableResponse(200, JSON.stringify({ id: "vid-001" }));
      };

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        uploadFetchImpl: fetchImpl,
        chunkSize: 256 * 1024,
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;

      const res = await upload.handler({
        file_path: file,
        title: "My Title",
        description: "desc",
        tags: ["a", "b"],
        category_id: "28",
        privacy_status: "public",
        notify_subscribers: true,
        scheduled_publish_time: undefined,
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text) as {
        success: boolean;
        data: { video_id: string; url: string };
      };
      expect(parsed.success).toBe(true);
      expect(parsed.data.video_id).toBe("vid-001");
      expect(parsed.data.url).toBe("https://www.youtube.com/watch?v=vid-001");
    });

    /**
     * Regression: Zod's default `.strip` silently drops unknown keys, which
     * would mean optional UI/admin fields never reach the handler. This test
     * asserts the schema declares every field the upload pipeline forwards.
     */
    it("accepts every documented field without stripping", () => {
      const tools = createYouTubePublishTools();
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;

      const args = {
        file_path: "/tmp/x.mp4",
        title: "T",
        description: "D",
        tags: ["a"],
        category_id: "22",
        privacy_status: "unlisted" as const,
        notify_subscribers: false,
        scheduled_publish_time: "2099-01-01T00:00:00Z",
        made_for_kids: true,
      };
      const parsed = upload.zodSchema.safeParse(args);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(args);
      }
    });
  });

  describe("youtube-set-thumbnail", () => {
    it("rejects thumbnails larger than 2 MB", async () => {
      const big = await writeTempFile(2 * 1024 * 1024 + 1, ".jpg");
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const thumb = tools.find((t) => t.name === "youtube-set-thumbnail")!;

      const res = await thumb.handler({
        video_id: "vid-001",
        image_path: big,
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("2 MB");
    });

    it("POSTs the image and returns the thumbnail URL", async () => {
      const img = await writeTempFile(1024, ".jpg");
      const fetchSpy = vi.fn(async () =>
        makeFetchResponse(
          200,
          JSON.stringify({
            items: [
              {
                default: { url: "https://i.ytimg.com/d.jpg" },
                high: { url: "https://i.ytimg.com/h.jpg" },
                maxres: { url: "https://i.ytimg.com/m.jpg" },
              },
            ],
          }),
        ),
      ) as unknown as typeof fetch;

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        fetchImpl: fetchSpy,
      });
      const thumb = tools.find((t) => t.name === "youtube-set-thumbnail")!;

      const res = await thumb.handler({
        video_id: "vid-001",
        image_path: img,
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text) as {
        success: boolean;
        data: { thumbnail_url: string };
      };
      expect(parsed.success).toBe(true);
      expect(parsed.data.thumbnail_url).toBe("https://i.ytimg.com/m.jpg");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("returns isError on API failure", async () => {
      const img = await writeTempFile(1024, ".png");
      const fetchSpy = vi.fn(async () =>
        makeFetchResponse(403, '{"error":{"message":"quotaExceeded"}}'),
      ) as unknown as typeof fetch;

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        fetchImpl: fetchSpy,
      });
      const thumb = tools.find((t) => t.name === "youtube-set-thumbnail")!;
      const res = await thumb.handler({ video_id: "v", image_path: img });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("quotaExceeded");
    });
  });

  describe("youtube-update-metadata", () => {
    it("merges existing snippet with provided fields", async () => {
      const calls: Array<{ url: string; method?: string; body?: string }> = [];
      const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (init?.method === "GET" || init === undefined) {
          return makeFetchResponse(
            200,
            JSON.stringify({
              items: [
                {
                  snippet: {
                    title: "old title",
                    description: "old desc",
                    tags: ["old"],
                    categoryId: "10",
                  },
                },
              ],
            }),
          );
        }
        return makeFetchResponse(
          200,
          JSON.stringify({
            snippet: { title: "old title", description: "new desc" },
          }),
        );
      }) as unknown as typeof fetch;

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        fetchImpl: fetchSpy,
      });
      const update = tools.find((t) => t.name === "youtube-update-metadata")!;

      const res = await update.handler({
        video_id: "vid-001",
        description: "new desc",
      });
      expect(res.isError).toBeFalsy();

      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toContain("videos?part=snippet");
      expect(calls[1]?.url).toContain("part=snippet");

      const putBody = JSON.parse(calls[1]?.body ?? "{}") as {
        snippet: { title: string; description: string; categoryId: string };
      };
      // Existing fields preserved, only description changed.
      expect(putBody.snippet.title).toBe("old title");
      expect(putBody.snippet.description).toBe("new desc");
      expect(putBody.snippet.categoryId).toBe("10");
    });

    it("rejects calls with no updatable fields", async () => {
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const update = tools.find((t) => t.name === "youtube-update-metadata")!;
      const parsed = update.zodSchema.safeParse({ video_id: "v" });
      expect(parsed.success).toBe(false);
    });

    it("can update only privacy_status without snippet round-trip", async () => {
      const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        return makeFetchResponse(
          200,
          JSON.stringify({ status: { privacyStatus: "public" } }),
        );
      }) as unknown as typeof fetch;

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        fetchImpl: fetchSpy,
      });
      const update = tools.find((t) => t.name === "youtube-update-metadata")!;

      const res = await update.handler({
        video_id: "vid-002",
        privacy_status: "public",
      });
      expect(res.isError).toBeFalsy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("registers all three tools with the expected names and risk levels", () => {
    const tools = createYouTubePublishTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "youtube-set-thumbnail",
      "youtube-update-metadata",
      "youtube-upload-video",
    ]);
    expect(
      tools.find((t) => t.name === "youtube-upload-video")?.riskLevel,
    ).toBe("high");
    expect(
      tools.find((t) => t.name === "youtube-set-thumbnail")?.riskLevel,
    ).toBe("medium");
    expect(
      tools.find((t) => t.name === "youtube-update-metadata")?.riskLevel,
    ).toBe("medium");
  });
});
