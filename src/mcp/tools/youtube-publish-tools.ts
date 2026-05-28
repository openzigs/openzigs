/**
 * YouTube publish MCP tools — Node-native implementations that talk directly
 * to the YouTube Data API v3 instead of proxying to the Python sidecar.
 *
 * Registered tools:
 *   - youtube-upload-video    (resumable; replaces the sidecar version)
 *   - youtube-set-thumbnail
 *   - youtube-update-metadata
 *
 * Each tool uses an OAuth access token from env (`YOUTUBE_OAUTH_TOKEN`). If
 * absent, the call returns `{ isError: true }` instead of throwing — the
 * audit log and the approval queue still get to see the attempt.
 */

import { promises as fsPromises } from "node:fs";
import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import {
  assertPathAllowed,
  PathNotAllowedError,
  sniffFileMime,
  VIDEO_MIME_TYPES,
  IMAGE_MIME_TYPES,
} from "./path-allowlist.js";
import {
  YouTubeResumableUploader,
  type ResumableFetch,
  type YouTubeUploadMetadata,
} from "./youtube-resumable-upload.js";

/** Tools share a single fetch + token-resolver so tests can inject both. */
export interface YouTubePublishToolsDeps {
  /** Returns the current OAuth access token, or `null` if not configured. */
  getAccessToken?: () => Promise<string | null> | string | null;
  /** Override `fetch` (used for thumbnail / metadata calls). */
  fetchImpl?: typeof fetch;
  /** Override the resumable-upload transport (separate so tests can stream-mock). */
  uploadFetchImpl?: ResumableFetch;
  /** Chunk size for resumable uploads. */
  chunkSize?: number;
}

const uploadVideoSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path to the video file on disk"),
  title: z.string().min(1).max(100).describe("Video title (1–100 characters)"),
  description: z
    .string()
    .max(5000)
    .optional()
    .describe("Video description (max 5000 characters)"),
  tags: z
    .array(z.string().max(500))
    .max(500)
    .optional()
    .describe("Keyword tags"),
  category_id: z
    .string()
    .optional()
    .describe("YouTube category ID (default '22' = People & Blogs)"),
  privacy_status: z
    .enum(["public", "unlisted", "private"])
    .optional()
    .describe("Visibility (default 'private')"),
  notify_subscribers: z
    .boolean()
    .optional()
    .describe("Notify channel subscribers (default true)"),
  scheduled_publish_time: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      "RFC 3339 timestamp for scheduled publish (forces privacy_status='private' until that time)",
    ),
  made_for_kids: z
    .boolean()
    .optional()
    .describe("Self-declare the video as made for kids (default false)"),
});

const setThumbnailSchema = z.object({
  video_id: z.string().min(1).describe("YouTube video ID"),
  image_path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the thumbnail image (jpg/png/gif, ≤2 MB, ≥640px wide)",
    ),
});

const updateMetadataSchema = z
  .object({
    video_id: z.string().min(1),
    title: z.string().min(1).max(100).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().max(500)).max(500).optional(),
    category_id: z.string().optional(),
    privacy_status: z.enum(["public", "unlisted", "private"]).optional(),
  })
  .refine(
    (val) =>
      val.title !== undefined ||
      val.description !== undefined ||
      val.tags !== undefined ||
      val.category_id !== undefined ||
      val.privacy_status !== undefined,
    {
      message:
        "At least one of title, description, tags, category_id, privacy_status must be provided",
    },
  );

const defaultGetAccessToken = (): string | null => {
  const token = (process.env.YOUTUBE_OAUTH_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
};

const errorPayload = (msg: string): { text: string; isError: true } => ({
  text: JSON.stringify({ success: false, error: msg }),
  isError: true,
});

const buildMetadata = (args: {
  title: string;
  description?: string;
  tags?: string[];
  category_id?: string;
  privacy_status?: "public" | "unlisted" | "private";
  scheduled_publish_time?: string;
  made_for_kids?: boolean;
}): YouTubeUploadMetadata => ({
  snippet: {
    title: args.title,
    description: args.description ?? "",
    tags: args.tags,
    categoryId: args.category_id ?? "22",
  },
  status: {
    privacyStatus: args.scheduled_publish_time
      ? "private"
      : (args.privacy_status ?? "private"),
    selfDeclaredMadeForKids: args.made_for_kids ?? false,
    publishAt: args.scheduled_publish_time,
  },
});

export const createYouTubePublishTools = (
  deps: YouTubePublishToolsDeps = {},
): ToolDefinition[] => {
  const resolveToken = async (): Promise<string | null> => {
    const fn = deps.getAccessToken ?? defaultGetAccessToken;
    return (await fn()) ?? null;
  };
  const f = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);

  return [
    {
      name: "youtube-upload-video",
      description:
        "Upload a video file to YouTube using resumable upload. Supports files up to 256 GB, streams from disk, and retries on transient (5xx) failures. Requires YOUTUBE_OAUTH_TOKEN with youtube.upload scope.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          category_id: { type: "string" },
          privacy_status: {
            type: "string",
            enum: ["public", "unlisted", "private"],
          },
          notify_subscribers: { type: "boolean" },
          scheduled_publish_time: { type: "string" },
          made_for_kids: { type: "boolean" },
        },
        required: ["file_path", "title"],
      },
      zodSchema: uploadVideoSchema,
      category: "social",
      riskLevel: "high",
      source: "youtube",
      handler: async (rawArgs) => {
        const args = rawArgs as z.infer<typeof uploadVideoSchema>;
        const token = await resolveToken();
        if (!token) {
          return errorPayload(
            "YOUTUBE_OAUTH_TOKEN is not configured. Connect YouTube in Settings.",
          );
        }
        let safePath: string;
        try {
          safePath = await assertPathAllowed(args.file_path);
        } catch (error) {
          if (error instanceof PathNotAllowedError) {
            return errorPayload(`Video file rejected: ${error.message}`);
          }
          return errorPayload(`Video file not found: ${args.file_path}`);
        }

        const sniffed = await sniffFileMime(safePath);
        if (
          !sniffed ||
          !(VIDEO_MIME_TYPES as readonly string[]).includes(sniffed)
        ) {
          return errorPayload(
            `Video file rejected: contents are not a recognized video container (${sniffed ?? "unknown"}). Allowed: ${VIDEO_MIME_TYPES.join(", ")}`,
          );
        }

        const uploader = new YouTubeResumableUploader({
          accessToken: token,
          fetchImpl: deps.uploadFetchImpl,
          chunkSize: deps.chunkSize,
        });

        try {
          const result = await uploader.uploadFile(
            safePath,
            buildMetadata(args),
            sniffed,
            { notifySubscribers: args.notify_subscribers },
          );
          return {
            text: JSON.stringify({
              success: true,
              data: {
                video_id: result.videoId,
                videoId: result.videoId,
                url: result.videoUrl,
                videoUrl: result.videoUrl,
              },
            }),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return errorPayload(msg);
        }
      },
    },

    {
      name: "youtube-set-thumbnail",
      description:
        "Set or replace the thumbnail for a YouTube video. Image must be ≤2 MB and ≥640px wide.",
      inputSchema: {
        type: "object",
        properties: {
          video_id: { type: "string" },
          image_path: { type: "string" },
        },
        required: ["video_id", "image_path"],
      },
      zodSchema: setThumbnailSchema,
      category: "social",
      riskLevel: "medium",
      source: "youtube",
      handler: async (rawArgs) => {
        const args = rawArgs as z.infer<typeof setThumbnailSchema>;
        const token = await resolveToken();
        if (!token) {
          return errorPayload(
            "YOUTUBE_OAUTH_TOKEN is not configured. Connect YouTube in Settings.",
          );
        }

        let safePath: string;
        try {
          safePath = await assertPathAllowed(args.image_path);
        } catch (error) {
          if (error instanceof PathNotAllowedError) {
            return errorPayload(`Thumbnail rejected: ${error.message}`);
          }
          return errorPayload(
            `Cannot read thumbnail file: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const sniffed = await sniffFileMime(safePath);
        if (
          !sniffed ||
          !(IMAGE_MIME_TYPES as readonly string[]).includes(sniffed)
        ) {
          return errorPayload(
            `Thumbnail rejected: contents are not a recognized image (${sniffed ?? "unknown"}). Allowed: ${IMAGE_MIME_TYPES.join(", ")}`,
          );
        }

        let body: Buffer;
        try {
          body = await fsPromises.readFile(safePath);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return errorPayload(`Cannot read thumbnail file: ${msg}`);
        }
        if (body.length > 2 * 1024 * 1024) {
          return errorPayload(
            `Thumbnail exceeds YouTube's 2 MB limit (${body.length} bytes).`,
          );
        }

        const url = `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(
          args.video_id,
        )}&uploadType=media`;
        try {
          const res = await f(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": sniffed,
              "Content-Length": String(body.length),
            },
            body,
          });
          const text = await res.text();
          if (res.status !== 200) {
            return errorPayload(
              `YouTube thumbnail upload failed (${res.status}): ${text}`,
            );
          }
          const parsed = JSON.parse(text) as {
            items?: Array<{
              default?: { url?: string };
              high?: { url?: string };
              maxres?: { url?: string };
            }>;
          };
          const item = parsed.items?.[0];
          const thumbUrl =
            item?.maxres?.url ?? item?.high?.url ?? item?.default?.url ?? null;
          return {
            text: JSON.stringify({
              success: true,
              data: { video_id: args.video_id, thumbnail_url: thumbUrl },
            }),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return errorPayload(msg);
        }
      },
    },

    {
      name: "youtube-update-metadata",
      description:
        "Update title, description, tags, category, or visibility on a YouTube video. Only the fields you provide are updated.",
      inputSchema: {
        type: "object",
        properties: {
          video_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          category_id: { type: "string" },
          privacy_status: {
            type: "string",
            enum: ["public", "unlisted", "private"],
          },
        },
        required: ["video_id"],
      },
      zodSchema: updateMetadataSchema,
      category: "social",
      riskLevel: "medium",
      source: "youtube",
      handler: async (rawArgs) => {
        const args = rawArgs as z.infer<typeof updateMetadataSchema>;
        const token = await resolveToken();
        if (!token) {
          return errorPayload(
            "YOUTUBE_OAUTH_TOKEN is not configured. Connect YouTube in Settings.",
          );
        }

        // YouTube's videos.update is REST-y: if you send the `snippet` part you
        // must include title + categoryId or the request 400s. So we fetch the
        // current video first to merge fields the caller didn't supply.
        const parts: string[] = [];
        const snippetChanged =
          args.title !== undefined ||
          args.description !== undefined ||
          args.tags !== undefined ||
          args.category_id !== undefined;
        if (snippetChanged) parts.push("snippet");
        if (args.privacy_status !== undefined) parts.push("status");

        if (parts.length === 0) {
          return errorPayload("No metadata fields provided");
        }

        let existing: {
          snippet?: {
            title?: string;
            description?: string;
            tags?: string[];
            categoryId?: string;
          };
          status?: { privacyStatus?: string };
        } = {};

        if (snippetChanged) {
          try {
            const getUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(
              args.video_id,
            )}`;
            const getRes = await f(getUrl, {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
            });
            const getText = await getRes.text();
            if (getRes.status !== 200) {
              return errorPayload(
                `Failed to load existing video (${getRes.status}): ${getText}`,
              );
            }
            const parsed = JSON.parse(getText) as {
              items?: Array<typeof existing>;
            };
            existing = parsed.items?.[0] ?? {};
            if (!existing.snippet) {
              return errorPayload(`Video not found: ${args.video_id}`);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return errorPayload(`Failed to load existing video: ${msg}`);
          }
        }

        const body: Record<string, unknown> = { id: args.video_id };
        if (snippetChanged) {
          body.snippet = {
            title: args.title ?? existing.snippet?.title ?? "",
            description:
              args.description ?? existing.snippet?.description ?? "",
            tags: args.tags ?? existing.snippet?.tags,
            categoryId:
              args.category_id ?? existing.snippet?.categoryId ?? "22",
          };
        }
        if (args.privacy_status !== undefined) {
          body.status = { privacyStatus: args.privacy_status };
        }

        try {
          const url = `https://www.googleapis.com/youtube/v3/videos?part=${parts.join(",")}`;
          const res = await f(url, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          const text = await res.text();
          if (res.status !== 200) {
            return errorPayload(
              `YouTube metadata update failed (${res.status}): ${text}`,
            );
          }
          const parsed = JSON.parse(text) as Record<string, unknown>;
          return {
            text: JSON.stringify({
              success: true,
              data: {
                video_id: args.video_id,
                snippet: parsed.snippet,
                status: parsed.status,
              },
            }),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return errorPayload(msg);
        }
      },
    },
  ];
};
