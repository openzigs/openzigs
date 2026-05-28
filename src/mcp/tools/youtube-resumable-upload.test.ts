import { describe, expect, it, vi } from "vitest";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  YouTubeResumableUploader,
  parseRangeHeader,
  parseRetryAfter,
  buildResumableInitUrl,
  YOUTUBE_RESUMABLE_INIT_URL,
  type ResumableFetch,
  type ResumableFetchResponse,
} from "./youtube-resumable-upload.js";

/** Build a Headers-like object from a plain map. */
const buildHeaders = (
  h: Record<string, string>,
): {
  get: (name: string) => string | null;
} => ({
  get: (name: string) => h[name] ?? h[name.toLowerCase()] ?? null,
});

const makeResponse = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): ResumableFetchResponse => ({
  status,
  headers: buildHeaders(headers),
  text: async () => body,
});

describe("parseRangeHeader", () => {
  it("parses 'bytes=0-K' into K", () => {
    expect(parseRangeHeader("bytes=0-262143")).toBe(262143);
  });
  it("returns -1 for missing or malformed values", () => {
    expect(parseRangeHeader(null)).toBe(-1);
    expect(parseRangeHeader("garbage")).toBe(-1);
  });
});

describe("YouTubeResumableUploader", () => {
  const writeTempFile = async (bytes: number): Promise<string> => {
    const dir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "openzigs-yt-up-"),
    );
    const file = path.join(dir, "video.mp4");
    await fsPromises.writeFile(file, Buffer.alloc(bytes, "a"));
    return file;
  };

  it("initiates a session, streams chunks, and returns the videoId on 200", async () => {
    const file = await writeTempFile(512 * 1024); // 0.5 MB → 2 chunks @ 256 KB
    const sessionUrl = "https://upload.example/session-1";

    const calls: Array<{
      url: string;
      method?: string;
      headers: Record<string, string>;
    }> = [];

    const fetchImpl: ResumableFetch = async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
      });
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: sessionUrl });
      }
      const range = init.headers["Content-Range"] ?? "";
      // Final chunk — when it covers the last byte (511 / 524287), return 200.
      if (range.endsWith("/524288") && range.includes("-524287")) {
        return makeResponse(200, JSON.stringify({ id: "vid-xyz" }));
      }
      // Mid-upload: 308 with progress so far.
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      const endByte = match ? Number(match[2]) : 0;
      return makeResponse(308, "", { Range: `bytes=0-${endByte}` });
    };

    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });

    const result = await uploader.uploadFile(
      file,
      {
        snippet: { title: "T" },
        status: { privacyStatus: "private" },
      },
      "video/mp4",
    );

    expect(result.videoId).toBe("vid-xyz");
    expect(result.videoUrl).toBe("https://www.youtube.com/watch?v=vid-xyz");
    // 1 init + 2 chunks = 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("uploadType=resumable");
    expect(calls[0]?.headers["X-Upload-Content-Length"]).toBe("524288");
    expect(calls[1]?.headers["Content-Range"]).toBe("bytes 0-262143/524288");
    expect(calls[2]?.headers["Content-Range"]).toBe(
      "bytes 262144-524287/524288",
    );
  });

  it("retries on 503 then succeeds", async () => {
    const file = await writeTempFile(256 * 1024);
    let chunkAttempts = 0;
    const sleep = vi.fn(async () => {});

    const fetchImpl: ResumableFetch = async (url) => {
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: "https://up/x" });
      }
      chunkAttempts += 1;
      if (chunkAttempts === 1) {
        return makeResponse(503, "Service unavailable");
      }
      return makeResponse(200, JSON.stringify({ id: "after-retry" }));
    };

    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep,
    });

    const result = await uploader.uploadFile(
      file,
      {
        snippet: { title: "T" },
        status: { privacyStatus: "unlisted" },
      },
      "video/mp4",
    );

    expect(result.videoId).toBe("after-retry");
    expect(chunkAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("resumes from the server-advertised range when 308 reports partial progress", async () => {
    const file = await writeTempFile(512 * 1024);
    const chunkRanges: string[] = [];
    let chunkCalls = 0;

    const fetchImpl: ResumableFetch = async (url, init) => {
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: "https://up/y" });
      }
      chunkCalls += 1;
      const range = init.headers["Content-Range"] ?? "";
      chunkRanges.push(range);
      if (chunkCalls === 1) {
        // Pretend the server accepted only the first 128 KB of our 256 KB chunk.
        return makeResponse(308, "", { Range: "bytes=0-131071" });
      }
      // Subsequent uploads succeed; final one returns 200.
      if (range.endsWith("/524288") && range.includes("-524287")) {
        return makeResponse(200, JSON.stringify({ id: "partial-ok" }));
      }
      return makeResponse(308, "", {
        Range: `bytes=0-${/-(\d+)\//.exec(range)?.[1]}`,
      });
    };

    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });

    const result = await uploader.uploadFile(
      file,
      { snippet: { title: "T" }, status: { privacyStatus: "private" } },
      "video/mp4",
    );

    expect(result.videoId).toBe("partial-ok");
    expect(chunkRanges[0]).toBe("bytes 0-262143/524288");
    // After server acked through byte 131071, next chunk starts at 131072.
    expect(chunkRanges[1]?.startsWith("bytes 131072-")).toBe(true);
  });

  it("throws if init response has no Location header", async () => {
    const file = await writeTempFile(1024);
    const fetchImpl: ResumableFetch = async () => makeResponse(200, "");

    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });

    await expect(
      uploader.uploadFile(
        file,
        { snippet: { title: "T" }, status: { privacyStatus: "private" } },
        "video/mp4",
      ),
    ).rejects.toThrow(/no Location header/);
  });

  it("rejects chunk sizes that aren't multiples of 256 KB", () => {
    expect(
      () =>
        new YouTubeResumableUploader({
          accessToken: "tok",
          chunkSize: 100_000,
        }),
    ).toThrow(/256 KB/);
  });

  it("requires an access token", () => {
    expect(
      () =>
        new YouTubeResumableUploader({
          accessToken: "",
        }),
    ).toThrow();
  });

  it("throws when initSession returns a non-success status", async () => {
    const file = await writeTempFile(1024);
    const fetchImpl: ResumableFetch = async () =>
      makeResponse(403, "forbidden");
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(
      uploader.uploadFile(
        file,
        { snippet: { title: "T" }, status: { privacyStatus: "private" } },
        "video/mp4",
      ),
    ).rejects.toThrow(/Failed to start YouTube resumable session \(403\)/);
  });

  it("rejects empty files before contacting YouTube", async () => {
    const dir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "openzigs-yt-up-"),
    );
    const file = path.join(dir, "empty.mp4");
    await fsPromises.writeFile(file, Buffer.alloc(0));
    const fetchImpl = vi.fn();
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl: fetchImpl as unknown as ResumableFetch,
      sleep: async () => {},
    });
    await expect(
      uploader.uploadFile(
        file,
        { snippet: { title: "T" }, status: { privacyStatus: "private" } },
        "video/mp4",
      ),
    ).rejects.toThrow(/empty or missing/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when a chunk upload returns a non-retryable error status", async () => {
    const file = await writeTempFile(256 * 1024);
    const fetchImpl: ResumableFetch = async (url) => {
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: "https://up/err" });
      }
      return makeResponse(400, "bad request");
    };
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(
      uploader.uploadFile(
        file,
        { snippet: { title: "T" }, status: { privacyStatus: "private" } },
        "video/mp4",
      ),
    ).rejects.toThrow(/YouTube upload failed at byte 0 \(status 400\)/);
  });

  it("throws when the final 200 response is missing the video id", async () => {
    const file = await writeTempFile(256 * 1024);
    const fetchImpl: ResumableFetch = async (url) => {
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: "https://up/id" });
      }
      return makeResponse(200, JSON.stringify({ kind: "youtube#video" }));
    };
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(
      uploader.uploadFile(
        file,
        { snippet: { title: "T" }, status: { privacyStatus: "private" } },
        "video/mp4",
      ),
    ).rejects.toThrow(/missing 'id'/);
  });

  it("retries on transport errors and eventually surfaces the error", async () => {
    const file = await writeTempFile(1024);
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const fetchImpl: ResumableFetch = async () => {
      attempts += 1;
      throw new Error("ECONNRESET");
    };
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep,
    });
    await expect(
      uploader.uploadFile(
        file,
        { snippet: { title: "T" }, status: { privacyStatus: "private" } },
        "video/mp4",
      ),
    ).rejects.toThrow(/ECONNRESET/);
    expect(attempts).toBe(6); // 1 + 5 retries
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("invokes the onProgress callback as chunks are acknowledged", async () => {
    const file = await writeTempFile(512 * 1024);
    const onProgress = vi.fn();
    const fetchImpl: ResumableFetch = async (url, init) => {
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: "https://up/p" });
      }
      const range = init.headers["Content-Range"] ?? "";
      if (range.includes("-524287")) {
        return makeResponse(200, JSON.stringify({ id: "prog-ok" }));
      }
      return makeResponse(308, "", { Range: "bytes=0-262143" });
    };
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
      onProgress,
    });
    await uploader.uploadFile(
      file,
      { snippet: { title: "T" }, status: { privacyStatus: "private" } },
      "video/mp4",
    );
    expect(onProgress).toHaveBeenCalled();
    // Last call should be (total, total)
    const last = onProgress.mock.calls.at(-1);
    expect(last?.[0]).toBe(524288);
    expect(last?.[1]).toBe(524288);
  });

  it("queryProgress returns total when server reports 200", async () => {
    const fetchImpl: ResumableFetch = async () =>
      makeResponse(200, JSON.stringify({ id: "ok" }));
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(uploader.queryProgress("https://up/q", 1000)).resolves.toBe(
      1000,
    );
  });

  it("queryProgress returns acked byte count + 1 on 308", async () => {
    const fetchImpl: ResumableFetch = async () =>
      makeResponse(308, "", { Range: "bytes=0-99" });
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(uploader.queryProgress("https://up/q", 1000)).resolves.toBe(
      100,
    );
  });

  it("queryProgress throws on unexpected status", async () => {
    const fetchImpl: ResumableFetch = async () =>
      makeResponse(500, "internal", {});
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    // 500 is retryable, exhausts retries, then surfaces as unexpected status.
    await expect(uploader.queryProgress("https://up/q", 1000)).rejects.toThrow(
      /Unexpected status while querying upload progress/,
    );
  });

  it("buildResumableInitUrl appends notifySubscribers when set", () => {
    expect(buildResumableInitUrl(undefined)).toBe(YOUTUBE_RESUMABLE_INIT_URL);
    expect(buildResumableInitUrl(true)).toContain("notifySubscribers=true");
    expect(buildResumableInitUrl(false)).toContain("notifySubscribers=false");
  });

  it("retries on 429 and honors Retry-After (delta seconds)", async () => {
    const file = await writeTempFile(256 * 1024);
    const sleep = vi.fn(async () => {});
    let chunkAttempts = 0;
    const fetchImpl: ResumableFetch = async (url) => {
      if (url.includes("uploadType=resumable")) {
        return makeResponse(200, "", { Location: "https://up/r" });
      }
      chunkAttempts += 1;
      if (chunkAttempts === 1) {
        return makeResponse(429, "slow down", { "Retry-After": "2" });
      }
      return makeResponse(200, JSON.stringify({ id: "after-429" }));
    };
    const uploader = new YouTubeResumableUploader({
      accessToken: "tok",
      chunkSize: 256 * 1024,
      fetchImpl,
      sleep,
    });
    const result = await uploader.uploadFile(
      file,
      { snippet: { title: "T" }, status: { privacyStatus: "private" } },
      "video/mp4",
    );
    expect(result.videoId).toBe("after-429");
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
  });
  it("caps at 60s", () => {
    expect(parseRetryAfter("9999")).toBe(60_000);
  });
  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(60_000);
  });
  it("returns null for unparseable input", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("bananas")).toBeNull();
  });
});
