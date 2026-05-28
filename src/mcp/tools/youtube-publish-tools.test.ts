import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createYouTubePublishTools } from "./youtube-publish-tools.js";
import type {
  ResumableFetch,
  ResumableFetchResponse,
} from "./youtube-resumable-upload.js";

/** Renders dir is on the allowlist; tmpdir is not — write here so paths pass. */
const RENDERS_DIR = path.join(
  os.homedir(),
  ".openzigs",
  "renders",
  "__pubtests__",
);

/** Real magic bytes so the MIME sniff classifies these as actual containers. */
const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const writeAllowedFile = async (
  totalBytes: number,
  ext: ".mp4" | ".jpg" | ".png" = ".mp4",
  name = `clip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
): Promise<string> => {
  await fsPromises.mkdir(RENDERS_DIR, { recursive: true });
  const file = path.join(RENDERS_DIR, `${name}${ext}`);
  const header =
    ext === ".jpg" ? JPEG_HEADER : ext === ".png" ? PNG_HEADER : MP4_HEADER;
  const padding = Math.max(0, totalBytes - header.length);
  await fsPromises.writeFile(
    file,
    Buffer.concat([header, Buffer.alloc(padding, "a")]),
  );
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

  afterEach(async () => {
    delete process.env.YOUTUBE_OAUTH_TOKEN;
    await fsPromises.rm(RENDERS_DIR, { recursive: true, force: true });
  });

  describe("youtube-upload-video", () => {
    it("returns isError when no OAuth token is configured", async () => {
      const tools = createYouTubePublishTools();
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;

      const file = await writeAllowedFile(1024);
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
        file_path: path.join(RENDERS_DIR, "does-not-exist-xyz.mp4"),
        title: "T",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/rejected|not found/);
    });

    it("uploads via the injected fetch and returns {video_id, url}", async () => {
      const file = await writeAllowedFile(256 * 1024);
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

    it("forwards notify_subscribers=false as a URL query param on the init request", async () => {
      const file = await writeAllowedFile(256 * 1024);
      const seenUrls: string[] = [];
      const fetchImpl: ResumableFetch = async (url) => {
        seenUrls.push(url);
        if (url.includes("uploadType=resumable")) {
          return makeResumableResponse(200, "", { Location: "https://up/x" });
        }
        return makeResumableResponse(200, JSON.stringify({ id: "v" }));
      };

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        uploadFetchImpl: fetchImpl,
        chunkSize: 256 * 1024,
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      await upload.handler({
        file_path: file,
        title: "T",
        notify_subscribers: false,
      });
      const initUrl = seenUrls.find((u) => u.includes("uploadType=resumable"));
      expect(initUrl).toBeDefined();
      expect(initUrl).toContain("notifySubscribers=false");
    });

    it("forwards notify_subscribers=true as a URL query param on the init request", async () => {
      const file = await writeAllowedFile(256 * 1024);
      const seenUrls: string[] = [];
      const fetchImpl: ResumableFetch = async (url) => {
        seenUrls.push(url);
        if (url.includes("uploadType=resumable")) {
          return makeResumableResponse(200, "", { Location: "https://up/x" });
        }
        return makeResumableResponse(200, JSON.stringify({ id: "v" }));
      };

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
        uploadFetchImpl: fetchImpl,
        chunkSize: 256 * 1024,
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      await upload.handler({
        file_path: file,
        title: "T",
        notify_subscribers: true,
      });
      const initUrl = seenUrls.find((u) => u.includes("uploadType=resumable"));
      expect(initUrl).toContain("notifySubscribers=true");
    });

    it("rejects file paths outside the allowlist (e.g. ~/.openzigs/auth.json)", async () => {
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      // Create a fake auth.json under .openzigs (deny list)
      const home = os.homedir();
      const fake = path.join(home, ".openzigs", "auth.json.test");
      // Test the deny: try the literal denied basename
      const denyTarget = path.join(home, ".openzigs", "auth.json");
      const res = await upload.handler({
        file_path: denyTarget,
        title: "T",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/rejected|denied|outside/);
      // Clean up if we accidentally created one
      await fsPromises.rm(fake, { force: true });
    });

    it("rejects /etc/passwd", async () => {
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      const res = await upload.handler({
        file_path: "/etc/passwd",
        title: "T",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/rejected|outside/);
    });

    it("rejects a symlink that escapes the allowlist", async () => {
      await fsPromises.mkdir(RENDERS_DIR, { recursive: true });
      const outsideDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "openzigs-escape-"),
      );
      const outsideFile = path.join(outsideDir, "secret.mp4");
      await fsPromises.writeFile(outsideFile, MP4_HEADER);
      const symlink = path.join(RENDERS_DIR, `link-${Date.now()}.mp4`);
      await fsPromises.symlink(outsideFile, symlink);

      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      const res = await upload.handler({ file_path: symlink, title: "T" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/rejected|outside/);
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    });

    it("rejects a file whose contents are not a real video container", async () => {
      await fsPromises.mkdir(RENDERS_DIR, { recursive: true });
      const bogus = path.join(RENDERS_DIR, `bogus-${Date.now()}.mp4`);
      await fsPromises.writeFile(bogus, Buffer.from("#!/bin/sh\necho pwned\n"));
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      const res = await upload.handler({ file_path: bogus, title: "T" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not a recognized video/);
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
    it("rejects scheduled_publish_time that is not RFC 3339", () => {
      const tools = createYouTubePublishTools();
      const upload = tools.find((t) => t.name === "youtube-upload-video")!;
      const parsed = upload.zodSchema.safeParse({
        file_path: "/tmp/x.mp4",
        title: "T",
        scheduled_publish_time: "not-a-date",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("youtube-set-thumbnail", () => {
    it("rejects thumbnails larger than 2 MB", async () => {
      const big = await writeAllowedFile(2 * 1024 * 1024 + 1, ".jpg");
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
      const img = await writeAllowedFile(1024, ".jpg");
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
      const img = await writeAllowedFile(1024, ".png");
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
    it("rejects thumbnails outside the allowlist (e.g. /etc/hosts)", async () => {
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const thumb = tools.find((t) => t.name === "youtube-set-thumbnail")!;
      const res = await thumb.handler({
        video_id: "v",
        image_path: "/etc/hosts",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/rejected|outside/);
    });

    it("rejects thumbnails whose contents are not a real image", async () => {
      await fsPromises.mkdir(RENDERS_DIR, { recursive: true });
      const bogus = path.join(RENDERS_DIR, `bogus-${Date.now()}.jpg`);
      await fsPromises.writeFile(bogus, Buffer.from("not an image"));
      const tools = createYouTubePublishTools({
        getAccessToken: () => "tok",
      });
      const thumb = tools.find((t) => t.name === "youtube-set-thumbnail")!;
      const res = await thumb.handler({ video_id: "v", image_path: bogus });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not a recognized image/);
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
