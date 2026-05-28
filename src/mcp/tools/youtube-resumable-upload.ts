/**
 * YouTube Data API v3 resumable upload — Node-native implementation.
 *
 * Why hand-rolled instead of `googleapis`:
 *  - The rest of the codebase talks to Google OAuth via `fetch`; staying on
 *    `fetch` keeps the dep surface narrow and lets us stream chunks from disk
 *    without buffering the whole file in memory (required for ≥2 GB videos).
 *  - The retry / 308 resume protocol is small enough to express directly and
 *    much easier to unit-test with a fake transport than `googleapis` is.
 *
 * Protocol (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
 *  1. POST to /upload/youtube/v3/videos?uploadType=resumable with snippet+status JSON
 *     → response includes `Location` header → resumable session URL.
 *  2. PUT chunks to the session URL with `Content-Range: bytes A-B/total`.
 *  3. 200/201 = done; 308 = continue (look at `Range: bytes=0-K` to know what
 *     YouTube has, resume from K+1); 5xx = retry with exponential backoff.
 *  4. To recover after a network failure, query progress by PUTing with
 *     `Content-Range: bytes * / total` and empty body.
 */

import { createReadStream, promises as fsPromises } from "node:fs";

export const YOUTUBE_RESUMABLE_INIT_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

/** Chunk size MUST be a multiple of 256 KB per Google's spec; 8 MB is the typical sweet spot. */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;

export interface YouTubeUploadMetadata {
  snippet: {
    title: string;
    description?: string;
    tags?: string[];
    categoryId?: string;
  };
  status: {
    privacyStatus: "public" | "unlisted" | "private";
    selfDeclaredMadeForKids?: boolean;
    publishAt?: string;
  };
}

export interface ResumableFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Minimal fetch surface — matches the global `fetch`, but explicit so tests can mock. */
export type ResumableFetch = (
  url: string,
  init: {
    method: "POST" | "PUT" | "GET";
    headers: Record<string, string>;
    body?: string | Uint8Array | Buffer | NodeJS.ReadableStream;
    duplex?: "half";
  },
) => Promise<ResumableFetchResponse>;

export interface ResumableUploaderOptions {
  /** Bearer access token (already refreshed). */
  accessToken: string;
  /** Bytes per PUT request. Multiple of 256 KB; default 8 MB. */
  chunkSize?: number;
  /** Injectable transport. Defaults to global `fetch`. */
  fetchImpl?: ResumableFetch;
  /** Inject a sleep so tests can run without real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook for observing progress. */
  onProgress?: (uploaded: number, total: number) => void;
}

export interface ResumableUploadResult {
  videoId: string;
  videoUrl: string;
  /** The full JSON body YouTube returned on the final PUT (parsed). */
  raw: Record<string, unknown>;
}

const defaultFetch: ResumableFetch = async (url, init) =>
  // The global fetch returns a Response, which satisfies ResumableFetchResponse.
  // duplex: "half" is required by Node when streaming a body.
  (await (globalThis.fetch as unknown as ResumableFetch)(
    url,
    init,
  )) as unknown as ResumableFetchResponse;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parse `Range: bytes=0-K` into K (the last byte YouTube has). Returns -1 if no progress. */
export function parseRangeHeader(value: string | null): number {
  if (!value) return -1;
  const match = /bytes=0-(\d+)/.exec(value);
  if (!match) return -1;
  return Number.parseInt(match[1] ?? "-1", 10);
}

export class YouTubeResumableUploader {
  private readonly accessToken: string;
  private readonly chunkSize: number;
  private readonly fetchImpl: ResumableFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onProgress?: (uploaded: number, total: number) => void;

  constructor(options: ResumableUploaderOptions) {
    if (!options.accessToken) {
      throw new Error("accessToken is required for resumable upload");
    }
    this.accessToken = options.accessToken;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (this.chunkSize % (256 * 1024) !== 0) {
      throw new Error("chunkSize must be a multiple of 256 KB");
    }
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.onProgress = options.onProgress;
  }

  /** Start a new resumable session and return the upload URL. */
  async initSession(
    metadata: YouTubeUploadMetadata,
    contentLength: number,
    mimeType: string,
  ): Promise<string> {
    const res = await this.requestWithRetry(() =>
      this.fetchImpl(YOUTUBE_RESUMABLE_INIT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(contentLength),
          "X-Upload-Content-Type": mimeType,
        },
        body: JSON.stringify(metadata),
      }),
    );

    if (res.status !== 200 && res.status !== 201) {
      const body = await res.text();
      throw new Error(
        `Failed to start YouTube resumable session (${res.status}): ${body}`,
      );
    }

    const location = res.headers.get("Location") ?? res.headers.get("location");
    if (!location) {
      throw new Error(
        "YouTube resumable init succeeded but no Location header was returned",
      );
    }
    return location;
  }

  /** Upload a single chunk and return the response. Handles retry/backoff internally. */
  async uploadChunk(
    sessionUrl: string,
    chunk: Buffer,
    rangeStart: number,
    totalSize: number,
    mimeType: string,
  ): Promise<ResumableFetchResponse> {
    const rangeEnd = rangeStart + chunk.length - 1;
    return this.requestWithRetry(() =>
      this.fetchImpl(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Type": mimeType,
          "Content-Range": `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
        },
        body: chunk,
      }),
    );
  }

  /** Query the server for how many bytes it already has on this session. */
  async queryProgress(sessionUrl: string, totalSize: number): Promise<number> {
    const res = await this.requestWithRetry(() =>
      this.fetchImpl(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "Content-Range": `bytes */${totalSize}`,
        },
      }),
    );
    if (res.status === 200 || res.status === 201) {
      // Server already has the whole thing.
      return totalSize;
    }
    if (res.status === 308) {
      return parseRangeHeader(res.headers.get("Range")) + 1;
    }
    const body = await res.text();
    throw new Error(
      `Unexpected status while querying upload progress (${res.status}): ${body}`,
    );
  }

  /**
   * Upload a video file end-to-end. Streams from disk in chunks; never loads
   * the whole file into memory. Retries individual chunks on 5xx; on 308 the
   * server's advertised `Range` is honored so a partial chunk doesn't
   * desynchronize the upload.
   */
  async uploadFile(
    filePath: string,
    metadata: YouTubeUploadMetadata,
    mimeType = "video/*",
  ): Promise<ResumableUploadResult> {
    const stat = await fsPromises.stat(filePath);
    const totalSize = stat.size;
    if (totalSize <= 0) {
      throw new Error(`File is empty or missing: ${filePath}`);
    }

    const sessionUrl = await this.initSession(metadata, totalSize, mimeType);

    let offset = 0;
    while (offset < totalSize) {
      const end = Math.min(offset + this.chunkSize, totalSize);
      const chunk = await readChunk(filePath, offset, end - 1);
      const res = await this.uploadChunk(
        sessionUrl,
        chunk,
        offset,
        totalSize,
        mimeType,
      );

      if (res.status === 200 || res.status === 201) {
        const body = await res.text();
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const videoId = typeof parsed.id === "string" ? parsed.id : undefined;
        if (!videoId) {
          throw new Error(
            `YouTube upload completed but response is missing 'id': ${body}`,
          );
        }
        this.onProgress?.(totalSize, totalSize);
        return {
          videoId,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          raw: parsed,
        };
      }

      if (res.status === 308) {
        const ack = parseRangeHeader(res.headers.get("Range"));
        if (ack >= offset) {
          offset = ack + 1;
        } else {
          // No progress reported — re-query and resume from there to stay in sync.
          offset = await this.queryProgress(sessionUrl, totalSize);
        }
        this.onProgress?.(offset, totalSize);
        continue;
      }

      const body = await res.text();
      throw new Error(
        `YouTube upload failed at byte ${offset} (status ${res.status}): ${body}`,
      );
    }

    // We exited the loop without a terminal 200/201 — query final state.
    const finalProgress = await this.queryProgress(sessionUrl, totalSize);
    throw new Error(
      `YouTube upload finished streaming ${totalSize} bytes but no terminal response was received (progress=${finalProgress})`,
    );
  }

  /**
   * Run a single request with exponential backoff on 5xx and transport errors.
   * 308 / 4xx are returned to the caller as-is — they encode upload protocol state.
   */
  private async requestWithRetry(
    perform: () => Promise<ResumableFetchResponse>,
  ): Promise<ResumableFetchResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await perform();
        if (RETRYABLE_STATUSES.has(res.status)) {
          if (attempt === MAX_RETRIES) {
            return res;
          }
          await this.sleep(backoffMs(attempt));
          continue;
        }
        return res;
      } catch (error) {
        lastError = error;
        if (attempt === MAX_RETRIES) {
          throw error;
        }
        await this.sleep(backoffMs(attempt));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Resumable upload retries exhausted");
  }
}

function backoffMs(attempt: number): number {
  // Exponential backoff with a 30s cap; deterministic so tests can assert wait time.
  const ms = BASE_BACKOFF_MS * 2 ** attempt;
  return Math.min(ms, 30_000);
}

async function readChunk(
  filePath: string,
  start: number,
  end: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end });
    stream.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
