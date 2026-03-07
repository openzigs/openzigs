import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../tool-registry.js";

const DRAFTS_BASE = path.join(os.homedir(), ".openzigs", "files", "drafts");

const saveDraftMediaSchema = z.object({
  source_path: z.string().describe("Absolute path to the source media file (e.g., from gallery result_url or generated file)"),
  title: z.string().max(200).describe("Human-readable title for the draft (used as filename base)"),
  project_id: z.string().optional().describe("Group drafts under a project directory"),
  media_type: z.enum(["image", "video", "audio"]).describe("Type of media being saved"),
});

type SaveDraftMediaInput = z.infer<typeof saveDraftMediaSchema>;

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export const createDraftMediaTools = (): ToolDefinition[] => {
  return [
    {
      name: "save-draft-media",
      description:
        "Save a generated or discovered media file to the drafts directory for later use in documents. Files are organized by project_id.",
      inputSchema: {
        type: "object",
        properties: {
          source_path: { type: "string", description: "Absolute path to the source media file" },
          title: { type: "string", description: "Human-readable title for the draft" },
          project_id: { type: "string", description: "Group drafts under a project directory" },
          media_type: { type: "string", enum: ["image", "video", "audio"], description: "Type of media" },
        },
        required: ["source_path", "title", "media_type"],
      },
      zodSchema: saveDraftMediaSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = saveDraftMediaSchema.parse(args) as SaveDraftMediaInput;
          const resolvedSource = path.resolve(input.source_path);

          // Verify source exists
          try {
            await fs.access(resolvedSource);
          } catch {
            return { text: `Source file not found: ${resolvedSource}`, isError: true };
          }

          // Build destination directory
          const projectDir = input.project_id
            ? path.join(DRAFTS_BASE, sanitizeFilename(input.project_id))
            : DRAFTS_BASE;
          await fs.mkdir(projectDir, { recursive: true });

          // Build destination filename
          const ext = path.extname(resolvedSource) || `.${input.media_type === "image" ? "png" : input.media_type === "video" ? "mp4" : "mp3"}`;
          const baseName = sanitizeFilename(input.title);
          const destPath = path.join(projectDir, `${baseName}${ext}`);

          // Copy the file
          await fs.copyFile(resolvedSource, destPath);

          return {
            text: JSON.stringify({
              saved: true,
              path: destPath,
              title: input.title,
              media_type: input.media_type,
              project_id: input.project_id ?? null,
            }),
          };
        } catch (err) {
          return {
            text: `Error saving draft media: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
