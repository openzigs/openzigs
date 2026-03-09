/**
 * MCP Tool: ingest-youtube — Download and catalog YouTube/audio content into the Gallery.
 * Uses yt-dlp for downloading and catalogs the result in the MediaAssets table.
 */

import * as z from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";
import type { MediaQueueRepository } from "../../queue/media-queue-repository.js";

const execFileAsync = promisify(execFile);

const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

const ingestYouTubeSchema = z.object({
  url: z.string().describe("The YouTube URL (or other yt-dlp supported URL) to download from"),
  format: z.enum(["video", "audio"]).describe("Whether to download as video (mp4, 1080p max) or extract audio only (mp3)"),
  title: z.string().optional().describe("Optional title/description for the gallery entry"),
  artist: z.string().optional().describe("Optional artist name for audio tracks"),
  tags: z.array(z.string()).optional().describe("Optional tags for gallery cataloging"),
  catalogInGallery: z.boolean().optional().describe("Whether to register the downloaded file in the Gallery database. Defaults to true. Set to false when downloading audio purely for transcription (e.g. research workflows)."),
});

type IngestArgs = z.infer<typeof ingestYouTubeSchema>;

export interface IngestYouTubeToolsOptions {
  repo: MediaQueueRepository;
}

export const createIngestYouTubeTools = ({ repo }: IngestYouTubeToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "ingest-youtube",
      description:
        "Download a YouTube video or extract audio (MP3) from a YouTube URL and catalog it in the OpenZigs Gallery. " +
        "IMPORTANT: You MUST use this tool to download YouTube content — do NOT use shell-execute with yt-dlp directly, " +
        "as that will download to the wrong location and the file will NOT appear in the Gallery. " +
        "This tool saves to the correct Gallery directory and registers the asset in the database automatically. " +
        "If the user provides a direct URL, use it immediately. If not, search the web first to find the URL. " +
        "ALWAYS use ask_user to confirm format before calling this tool: ask 'Do you want the full video (MP4) or audio only (MP3)?' " +
        "with choices ['Video (MP4)', 'Audio only (MP3)'] — unless the user has already clearly said 'video' or 'audio' in their message.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The YouTube URL to download" },
          format: { type: "string", enum: ["video", "audio"], description: "Download as video (mp4) or audio only (mp3)" },
          title: { type: "string", description: "Optional title for the gallery entry" },
          artist: { type: "string", description: "Optional artist name for audio tracks" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
          catalogInGallery: { type: "boolean", description: "Whether to register in Gallery DB. Defaults to true. Set to false for research/transcription-only downloads." },
        },
        required: ["url", "format"],
      },
      zodSchema: ingestYouTubeSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        const { url, format, title, artist, tags, catalogInGallery } = args as IngestArgs;
        const shouldCatalog = catalogInGallery !== false;

        // Validate URL is a plausible media URL (prevent command injection)
        if (!isValidMediaUrl(url)) {
          return { text: "Invalid URL. Please provide a valid YouTube or media URL.", isError: true };
        }

        // Ensure gallery directory exists
        await fs.mkdir(GALLERY_DIR, { recursive: true });

        // Check if yt-dlp is available
        try {
          await execFileAsync("which", ["yt-dlp"]);
        } catch {
          return {
            text: "yt-dlp is not installed. Please install it first:\n" +
              "• macOS: `brew install yt-dlp`\n" +
              "• pip: `pip install yt-dlp`\n" +
              "• Linux: `sudo apt install yt-dlp`\n\n" +
              "You can use the shell-execute tool to install it, or ask the user for permission.",
            isError: true,
          };
        }

        // Fetch video metadata first (title, duration, etc.)
        const metadata = await fetchMetadata(url);

        const outputTitle = title ?? metadata.title ?? "download";
        // Sanitize filename: remove special chars, limit length
        const safeTitle = outputTitle
          .replace(/[^\w\s\-_.]/g, "")
          .replace(/\s+/g, "_")
          .slice(0, 80);
        const timestamp = Date.now();

        try {
          if (format === "audio") {
            return await downloadAudio(url, safeTitle, timestamp, artist, tags, metadata, repo, shouldCatalog);
          } else {
            return await downloadVideo(url, safeTitle, timestamp, artist, tags, metadata, repo, shouldCatalog);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `Download failed: ${msg}`, isError: true };
        }
      },
    },
  ];
};

// ── Helpers ─────────────────────────────────────────────────

function isValidMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Allow http/https only to prevent command injection via protocol
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface VideoMetadata {
  title?: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
}

async function fetchMetadata(url: string): Promise<VideoMetadata> {
  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--no-download",
      "--print", "%(title)s\n%(duration)s\n%(uploader)s",
      "--no-warnings",
      "--no-playlist",
      url,
    ], { timeout: 30000 });

    const lines = stdout.trim().split("\n");
    return {
      title: lines[0] || undefined,
      duration: lines[1] ? parseFloat(lines[1]) : undefined,
      uploader: lines[2] || undefined,
    };
  } catch {
    return {};
  }
}

async function downloadAudio(
  url: string,
  safeTitle: string,
  timestamp: number,
  artist: string | undefined,
  tags: string[] | undefined,
  metadata: VideoMetadata,
  repo: MediaQueueRepository,
  catalogInGallery: boolean,
): Promise<{ text: string; isError?: boolean }> {
  // Use a base path without extension — yt-dlp will append the intermediate
  // extension, then ffmpeg will write the final .mp3 alongside it.
  const baseFilename = `${timestamp}-${safeTitle}`;
  const outputTemplate = path.join(GALLERY_DIR, `${baseFilename}.%(ext)s`);

  const { stderr } = await execFileAsync("yt-dlp", [
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--no-playlist",
    "--no-warnings",
    "-o", outputTemplate,
    url,
  ], { timeout: 300000 }); // 5 min timeout

  // Find the actual output file — yt-dlp writes base.mp3 after conversion
  const actualPath = await findOutputFile(GALLERY_DIR, baseFilename, [".mp3", ".m4a", ".webm", ".opus", ".ogg"]);
  if (!actualPath) {
    return {
      text: `Download completed but output file not found in ${GALLERY_DIR}.\nyt-dlp stderr: ${stderr?.slice(0, 500) ?? "(none)"}`,
      isError: true,
    };
  }

  const actualFilename = path.basename(actualPath);
  const stat = await fs.stat(actualPath);

  let assetId: string | undefined;
  if (catalogInGallery) {
    assetId = repo.createAsset({
      type: "audio",
      filename: actualFilename,
      filePath: actualPath,
      mimeType: "audio/mp3",
      fileSizeBytes: stat.size,
      durationSeconds: metadata.duration,
      prompt: metadata.title,
      source: "ingested",
      sourceUrl: url,
      artist: artist ?? metadata.uploader,
      tags: tags ?? ["youtube", "audio"],
    });
  }

  return {
    text: `Audio downloaded${catalogInGallery ? " and cataloged in Gallery" : ""}.\n` +
      `• File: ${actualFilename}\n` +
      `• Path: ${actualPath}\n` +
      `• Size: ${(stat.size / (1024 * 1024)).toFixed(1)} MB\n` +
      `• Duration: ${metadata.duration ? `${Math.floor(metadata.duration / 60)}m ${Math.floor(metadata.duration % 60)}s` : "unknown"}\n` +
      `• Artist: ${artist ?? metadata.uploader ?? "unknown"}\n` +
      (assetId ? `• Gallery ID: ${assetId}` : "• Gallery: skipped"),
  };
}

async function downloadVideo(
  url: string,
  safeTitle: string,
  timestamp: number,
  artist: string | undefined,
  tags: string[] | undefined,
  metadata: VideoMetadata,
  repo: MediaQueueRepository,
  catalogInGallery: boolean,
): Promise<{ text: string; isError?: boolean }> {
  const outputFilename = `${timestamp}-${safeTitle}.mp4`;
  const outputPath = path.join(GALLERY_DIR, outputFilename);

  const { stdout, stderr } = await execFileAsync("yt-dlp", [
    "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-warnings",
    "--force-overwrites",
    "-o", outputPath,
    url,
  ], { timeout: 600000 }); // 10 min timeout

  const actualPath = await findOutputFile(GALLERY_DIR, `${timestamp}-${safeTitle}`, [".mp4", ".mkv", ".webm"]);
  if (!actualPath) {
    return {
      text: `Download completed but output file not found in ${GALLERY_DIR}.\n` +
        `Expected prefix: ${timestamp}-${safeTitle}\n` +
        `yt-dlp stdout: ${stdout?.slice(0, 500) ?? "(none)"}\n` +
        `yt-dlp stderr: ${stderr?.slice(0, 500) ?? "(none)"}`,
      isError: true,
    };
  }

  const actualFilename = path.basename(actualPath);
  const stat = await fs.stat(actualPath);

  let assetId: string | undefined;
  if (catalogInGallery) {
    assetId = repo.createAsset({
      type: "video",
      filename: actualFilename,
      filePath: actualPath,
      mimeType: "video/mp4",
      fileSizeBytes: stat.size,
      durationSeconds: metadata.duration,
      prompt: metadata.title,
      source: "ingested",
      sourceUrl: url,
      artist: artist ?? metadata.uploader,
      tags: tags ?? ["youtube", "video"],
    });
  }

  return {
    text: `Video downloaded${catalogInGallery ? " and cataloged in Gallery" : ""}.\n` +
      `• File: ${actualFilename}\n` +
      `• Size: ${(stat.size / (1024 * 1024)).toFixed(1)} MB\n` +
      `• Duration: ${metadata.duration ? `${Math.floor(metadata.duration / 60)}m ${Math.floor(metadata.duration % 60)}s` : "unknown"}\n` +
      (assetId ? `• Gallery ID: ${assetId}` : "• Gallery: skipped"),
  };
}

async function findOutputFile(dir: string, prefix: string, extensions: string[]): Promise<string | null> {
  const files = await fs.readdir(dir);
  for (const ext of extensions) {
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith(ext));
    if (match) return path.join(dir, match);
  }
  // Fallback: find any file starting with the prefix
  const fallback = files.find((f) => f.startsWith(prefix));
  if (fallback) return path.join(dir, fallback);
  return null;
}
