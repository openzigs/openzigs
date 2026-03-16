#!/usr/bin/env node

/**
 * TikTok MCP Server — Official TikTok API v2
 *
 * Uses TikTok's Content Posting API, Display API, and Login Kit (OAuth v2).
 * Requires: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_ACCESS_TOKEN
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Config ────────────────────────────────────────────────────────────
const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY ?? "";
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET ?? "";
let ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN ?? "";
let REFRESH_TOKEN = process.env.TIKTOK_REFRESH_TOKEN ?? "";

const TOKEN_FILE = join(homedir(), ".openzigs", "tiktok-tokens.json");

// Persist / load tokens so refreshes survive restarts
function loadTokens() {
  if (existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
      if (data.access_token) ACCESS_TOKEN = data.access_token;
      if (data.refresh_token) REFRESH_TOKEN = data.refresh_token;
    } catch { /* use env fallback */ }
  }
}

function saveTokens() {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      updated_at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}

loadTokens();

if (!ACCESS_TOKEN) {
  console.error("Warning: TIKTOK_ACCESS_TOKEN not set — read-only tools may still work after auth");
}

// ── HTTP helpers ──────────────────────────────────────────────────────
interface TikTokResponse {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; log_id?: string };
}

async function tiktokGet(path: string): Promise<TikTokResponse> {
  const res = await fetch(`${TIKTOK_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return (await res.json()) as TikTokResponse;
}

async function tiktokPost(path: string, body: unknown): Promise<TikTokResponse> {
  const res = await fetch(`${TIKTOK_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as TikTokResponse;
}

function formatError(r: TikTokResponse): string {
  if (r.error && r.error.code !== "ok") {
    return `TikTok API error [${r.error.code}]: ${r.error.message}${r.error.log_id ? ` (log_id: ${r.error.log_id})` : ""}`;
  }
  return "";
}

// ── Tool definitions ─────────────────────────────────────────────────
const GET_USER_INFO: Tool = {
  name: "tiktok_get_user_info",
  description:
    "Get the authenticated TikTok user's profile info: display name, avatar, bio, follower/following/likes/video counts, verified status, username, and profile link.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const LIST_VIDEOS: Tool = {
  name: "tiktok_list_videos",
  description:
    "List the authenticated user's TikTok videos with pagination. Returns video id, title, description, duration, cover image URL, share URL, create time, and embed link.",
  inputSchema: {
    type: "object",
    properties: {
      max_count: {
        type: "number",
        description: "Number of videos to return (1-20, default 10)",
      },
      cursor: {
        type: "number",
        description: "Pagination cursor from a previous response",
      },
    },
    required: [],
  },
};

const QUERY_VIDEOS: Tool = {
  name: "tiktok_query_videos",
  description:
    "Query specific TikTok videos by their IDs. Returns video details including cover image and embed link.",
  inputSchema: {
    type: "object",
    properties: {
      video_ids: {
        type: "array",
        items: { type: "string" },
        description: "Array of TikTok video IDs to query",
      },
    },
    required: ["video_ids"],
  },
};

const QUERY_CREATOR_INFO: Tool = {
  name: "tiktok_query_creator_info",
  description:
    "Query the creator's posting permissions and privacy level options. Must be called before posting content to know which privacy levels are available.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const POST_VIDEO: Tool = {
  name: "tiktok_post_video",
  description:
    "Post a video to TikTok via Direct Post using PULL_FROM_URL. The video URL must be publicly accessible and from a verified domain. Returns a publish_id to track status. NOTE: Unaudited apps can only post to private viewing mode.",
  inputSchema: {
    type: "object",
    properties: {
      video_url: {
        type: "string",
        description: "Publicly accessible URL of the video to post",
      },
      title: {
        type: "string",
        description: "Post title (max 150 UTF-16 characters)",
      },
      privacy_level: {
        type: "string",
        enum: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
        description: "Privacy setting — must match one from tiktok_query_creator_info",
      },
      disable_comment: {
        type: "boolean",
        description: "Disable comments on this post (default false)",
      },
      disable_duet: {
        type: "boolean",
        description: "Disable duets on this post (default false)",
      },
      disable_stitch: {
        type: "boolean",
        description: "Disable stitches on this post (default false)",
      },
      brand_content_toggle: {
        type: "boolean",
        description: "Set true if this is paid partnership content (required)",
      },
      brand_organic_toggle: {
        type: "boolean",
        description: "Set true if promoting own business (required)",
      },
    },
    required: ["video_url", "privacy_level", "brand_content_toggle", "brand_organic_toggle"],
  },
};

const POST_PHOTO: Tool = {
  name: "tiktok_post_photo",
  description:
    "Post photos to TikTok via Direct Post using PULL_FROM_URL. Photo URLs must be publicly accessible. Up to 35 photos per post. Returns a publish_id to track status. NOTE: Unaudited apps can only post to private viewing mode.",
  inputSchema: {
    type: "object",
    properties: {
      photo_urls: {
        type: "array",
        items: { type: "string" },
        description: "Array of publicly accessible photo URLs (max 35)",
      },
      cover_index: {
        type: "number",
        description: "Index (0-based) of the photo to use as cover",
      },
      title: {
        type: "string",
        description: "Post title (max 90 UTF-16 characters)",
      },
      description: {
        type: "string",
        description: "Post description with hashtags/mentions (max 4000 UTF-16 characters)",
      },
      privacy_level: {
        type: "string",
        enum: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
        description: "Privacy setting — must match one from tiktok_query_creator_info",
      },
      disable_comment: {
        type: "boolean",
        description: "Disable comments (default false)",
      },
      auto_add_music: {
        type: "boolean",
        description: "Auto-add recommended music (default false)",
      },
      brand_content_toggle: {
        type: "boolean",
        description: "Set true if this is paid partnership content (required)",
      },
      brand_organic_toggle: {
        type: "boolean",
        description: "Set true if promoting own business (required)",
      },
    },
    required: ["photo_urls", "privacy_level", "brand_content_toggle", "brand_organic_toggle"],
  },
};

const GET_POST_STATUS: Tool = {
  name: "tiktok_get_post_status",
  description:
    "Check the status of a TikTok post by its publish_id. Returns status (PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, PUBLISH_COMPLETE, FAILED, etc.), fail_reason if any, and the public post_id once approved.",
  inputSchema: {
    type: "object",
    properties: {
      publish_id: {
        type: "string",
        description: "The publish_id returned from a post video/photo call",
      },
    },
    required: ["publish_id"],
  },
};

const REFRESH_ACCESS_TOKEN: Tool = {
  name: "tiktok_refresh_token",
  description:
    "Refresh the TikTok access token using the stored refresh token. Access tokens expire every 24 hours. Returns the new token expiry info.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const ALL_TOOLS = [
  GET_USER_INFO,
  LIST_VIDEOS,
  QUERY_VIDEOS,
  QUERY_CREATOR_INFO,
  POST_VIDEO,
  POST_PHOTO,
  GET_POST_STATUS,
  REFRESH_ACCESS_TOKEN,
];

// ── Tool handlers ────────────────────────────────────────────────────

async function handleGetUserInfo(): Promise<string> {
  const fields = [
    "open_id", "union_id", "avatar_url", "avatar_url_100",
    "display_name", "bio_description", "profile_deep_link",
    "is_verified", "username", "follower_count", "following_count",
    "likes_count", "video_count",
  ].join(",");
  const r = await tiktokGet(`/user/info/?fields=${fields}`);
  const err = formatError(r);
  if (err) return err;
  const u = (r.data?.user ?? {}) as Record<string, unknown>;
  return [
    `Username: ${u.username ?? "N/A"}`,
    `Display Name: ${u.display_name ?? "N/A"}`,
    `Bio: ${u.bio_description ?? "N/A"}`,
    `Verified: ${u.is_verified ?? false}`,
    `Followers: ${u.follower_count ?? 0}`,
    `Following: ${u.following_count ?? 0}`,
    `Likes: ${u.likes_count ?? 0}`,
    `Videos: ${u.video_count ?? 0}`,
    `Avatar: ${u.avatar_url ?? "N/A"}`,
    `Profile: ${u.profile_deep_link ?? "N/A"}`,
    `Open ID: ${u.open_id ?? "N/A"}`,
  ].join("\n");
}

async function handleListVideos(args: Record<string, unknown>): Promise<string> {
  const maxCount = Math.min(Math.max(Number(args.max_count) || 10, 1), 20);
  const fields = [
    "id", "title", "video_description", "duration",
    "cover_image_url", "embed_link", "create_time", "share_url",
  ].join(",");
  const body: Record<string, unknown> = { max_count: maxCount };
  if (args.cursor !== undefined) body.cursor = Number(args.cursor);
  const r = await tiktokPost(`/video/list/?fields=${fields}`, body);
  const err = formatError(r);
  if (err) return err;
  const videos = (r.data?.videos ?? []) as Record<string, unknown>[];
  if (videos.length === 0) return "No videos found.";
  const lines = videos.map((v, i) => [
    `Video ${i + 1}:`,
    `  ID: ${v.id}`,
    `  Title: ${v.title ?? "N/A"}`,
    `  Description: ${v.video_description ?? "N/A"}`,
    `  Duration: ${v.duration ?? 0}s`,
    `  Created: ${v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : "N/A"}`,
    `  Cover: ${v.cover_image_url ?? "N/A"}`,
    `  Share URL: ${v.share_url ?? "N/A"}`,
    `  Embed: ${v.embed_link ?? "N/A"}`,
  ].join("\n"));
  const cursor = r.data?.cursor;
  const hasMore = r.data?.has_more;
  lines.push(`\nPagination — cursor: ${cursor ?? "none"}, has_more: ${hasMore ?? false}`);
  return lines.join("\n\n");
}

async function handleQueryVideos(args: Record<string, unknown>): Promise<string> {
  const videoIds = args.video_ids;
  if (!Array.isArray(videoIds) || videoIds.length === 0) {
    return "Error: video_ids must be a non-empty array";
  }
  const fields = [
    "id", "title", "video_description", "duration",
    "cover_image_url", "embed_link", "create_time", "share_url",
  ].join(",");
  const r = await tiktokPost(`/video/query/?fields=${fields}`, {
    filters: { video_ids: videoIds },
  });
  const err = formatError(r);
  if (err) return err;
  const videos = (r.data?.videos ?? []) as Record<string, unknown>[];
  if (videos.length === 0) return "No matching videos found.";
  return videos.map((v, i) => [
    `Video ${i + 1}:`,
    `  ID: ${v.id}`,
    `  Title: ${v.title ?? "N/A"}`,
    `  Description: ${v.video_description ?? "N/A"}`,
    `  Duration: ${v.duration ?? 0}s`,
    `  Cover: ${v.cover_image_url ?? "N/A"}`,
    `  Embed: ${v.embed_link ?? "N/A"}`,
  ].join("\n")).join("\n\n");
}

async function handleQueryCreatorInfo(): Promise<string> {
  const r = await tiktokPost("/post/publish/creator_info/query/", {});
  const err = formatError(r);
  if (err) return err;
  const d = r.data ?? {};
  const privacyOptions = (d.privacy_level_options ?? []) as string[];
  const commentDisabled = d.comment_disabled ?? false;
  const duetDisabled = d.duet_disabled ?? false;
  const stitchDisabled = d.stitch_disabled ?? false;
  const maxVideoPostDuration = d.max_video_post_duration_sec ?? "N/A";
  return [
    `Privacy Level Options: ${privacyOptions.join(", ") || "None"}`,
    `Comment Disabled: ${commentDisabled}`,
    `Duet Disabled: ${duetDisabled}`,
    `Stitch Disabled: ${stitchDisabled}`,
    `Max Video Duration: ${maxVideoPostDuration}s`,
  ].join("\n");
}

async function handlePostVideo(args: Record<string, unknown>): Promise<string> {
  const postInfo: Record<string, unknown> = {
    privacy_level: args.privacy_level,
    brand_content_toggle: args.brand_content_toggle ?? false,
    brand_organic_toggle: args.brand_organic_toggle ?? false,
  };
  if (args.title) postInfo.title = args.title;
  if (args.disable_comment !== undefined) postInfo.disable_comment = args.disable_comment;
  if (args.disable_duet !== undefined) postInfo.disable_duet = args.disable_duet;
  if (args.disable_stitch !== undefined) postInfo.disable_stitch = args.disable_stitch;

  const r = await tiktokPost("/post/publish/video/init/", {
    post_info: postInfo,
    source_info: {
      source: "PULL_FROM_URL",
      video_url: args.video_url,
    },
    post_mode: "DIRECT_POST",
    media_type: "VIDEO",
  });
  const err = formatError(r);
  if (err) return err;
  const publishId = r.data?.publish_id ?? "unknown";
  return `Video post initiated.\nPublish ID: ${publishId}\n\nUse tiktok_get_post_status to track progress.`;
}

async function handlePostPhoto(args: Record<string, unknown>): Promise<string> {
  const photoUrls = args.photo_urls;
  if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
    return "Error: photo_urls must be a non-empty array";
  }
  if (photoUrls.length > 35) {
    return "Error: Maximum 35 photos per post";
  }

  const postInfo: Record<string, unknown> = {
    privacy_level: args.privacy_level,
    brand_content_toggle: args.brand_content_toggle ?? false,
    brand_organic_toggle: args.brand_organic_toggle ?? false,
  };
  if (args.title) postInfo.title = args.title;
  if (args.description) postInfo.description = args.description;
  if (args.disable_comment !== undefined) postInfo.disable_comment = args.disable_comment;
  if (args.auto_add_music !== undefined) postInfo.auto_add_music = args.auto_add_music;

  const r = await tiktokPost("/post/publish/content/init/", {
    post_info: postInfo,
    source_info: {
      source: "PULL_FROM_URL",
      photo_images: photoUrls,
      photo_cover_index: Number(args.cover_index) || 0,
    },
    post_mode: "DIRECT_POST",
    media_type: "PHOTO",
  });
  const err = formatError(r);
  if (err) return err;
  const publishId = r.data?.publish_id ?? "unknown";
  return `Photo post initiated.\nPublish ID: ${publishId}\n\nUse tiktok_get_post_status to track progress.`;
}

async function handleGetPostStatus(args: Record<string, unknown>): Promise<string> {
  if (!args.publish_id || typeof args.publish_id !== "string") {
    return "Error: publish_id is required";
  }
  const r = await tiktokPost("/post/publish/status/fetch/", {
    publish_id: args.publish_id,
  });
  const err = formatError(r);
  if (err) return err;
  const d = r.data ?? {};
  const postIds = (d.publicaly_available_post_id ?? []) as string[];
  return [
    `Status: ${d.status ?? "UNKNOWN"}`,
    d.fail_reason ? `Fail Reason: ${d.fail_reason}` : null,
    postIds.length > 0 ? `Public Post IDs: ${postIds.join(", ")}` : null,
    d.uploaded_bytes ? `Uploaded Bytes: ${d.uploaded_bytes}` : null,
    d.downloaded_bytes ? `Downloaded Bytes: ${d.downloaded_bytes}` : null,
  ].filter(Boolean).join("\n");
}

async function handleRefreshToken(): Promise<string> {
  if (!CLIENT_KEY || !CLIENT_SECRET) {
    return "Error: TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are required for token refresh";
  }
  if (!REFRESH_TOKEN) {
    return "Error: No refresh token available. Complete OAuth flow first.";
  }

  const res = await fetch(`${TIKTOK_API_BASE}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
  });
  const data = (await res.json()) as Record<string, unknown>;

  if (data.access_token) {
    ACCESS_TOKEN = data.access_token as string;
    if (data.refresh_token) REFRESH_TOKEN = data.refresh_token as string;
    saveTokens();
    return [
      "Token refreshed successfully.",
      `Expires in: ${data.expires_in ?? "unknown"} seconds`,
      `Refresh token expires in: ${data.refresh_expires_in ?? "unknown"} seconds`,
      `Scopes: ${data.scope ?? "N/A"}`,
    ].join("\n");
  }

  return `Token refresh failed: ${JSON.stringify(data)}`;
}

// ── Server ───────────────────────────────────────────────────────────
const server = new Server(
  { name: "openzigs/tiktok-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;
    let result: string;

    switch (name) {
      case "tiktok_get_user_info":
        result = await handleGetUserInfo();
        break;
      case "tiktok_list_videos":
        result = await handleListVideos(a);
        break;
      case "tiktok_query_videos":
        result = await handleQueryVideos(a);
        break;
      case "tiktok_query_creator_info":
        result = await handleQueryCreatorInfo();
        break;
      case "tiktok_post_video":
        result = await handlePostVideo(a);
        break;
      case "tiktok_post_photo":
        result = await handlePostPhoto(a);
        break;
      case "tiktok_get_post_status":
        result = await handleGetPostStatus(a);
        break;
      case "tiktok_refresh_token":
        result = await handleRefreshToken();
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    const isError = result.startsWith("Error:") || result.startsWith("TikTok API error");
    return { content: [{ type: "text", text: result }], isError };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TikTok MCP Server (Official API) running on stdio");
}

runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});