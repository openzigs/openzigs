import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../tool-registry.js";
import { PROJECT_ROOT } from "../../project-root.js";

const queryDocSchema = z.object({
  topic: z.string().min(1, "topic is required"),
  file: z
    .enum(["ARCHITECTURE", "USER_GUIDE", "TELEGRAM_SETUP", "CONFIG"])
    .optional(),
});

export type DocumentationToolsOptions = {
  /** Absolute path to the docs/ directory (defaults to <cwd>/docs). */
  docsDir?: string;
  /** Absolute path to the config/ directory (defaults to <cwd>/config). */
  configDir?: string;
};

/** Map logical file names to actual on-disk paths (relative to docsDir / configDir). */
const FILE_MAP: Record<string, { dir: "docs" | "config"; file: string }> = {
  ARCHITECTURE: { dir: "docs", file: "ARCHITECTURE.md" },
  USER_GUIDE: { dir: "docs", file: "USER_GUIDE.md" },
  TELEGRAM_SETUP: { dir: "docs", file: "TELEGRAM_SETUP.md" },
  CONFIG: { dir: "config", file: "default.json" },
};

/**
 * Extract sections from a Markdown document that match the given keywords.
 * Returns matching headings + their content (up to ~500 lines per match).
 */
const searchMarkdownSections = (
  content: string,
  keywords: string[]
): string[] => {
  const lines = content.split("\n");
  const matches: string[] = [];
  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  let sectionLines: string[] = [];
  let sectionMatches = false;

  const flushSection = () => {
    if (sectionMatches && sectionLines.length > 0) {
      const section = sectionLines.slice(0, 80).join("\n");
      matches.push(section);
    }
    sectionLines = [];
    sectionMatches = false;
  };

  for (const line of lines) {
    if (line.startsWith("#")) {
      flushSection();
      sectionLines.push(line);

      // Check if heading matches any keyword
      const lowerLine = line.toLowerCase();
      if (lowerKeywords.some((kw) => lowerLine.includes(kw))) {
        sectionMatches = true;
      }
    } else {
      sectionLines.push(line);

      // Check if content line matches any keyword (only mark, don't flush)
      if (!sectionMatches) {
        const lowerLine = line.toLowerCase();
        if (lowerKeywords.some((kw) => lowerLine.includes(kw))) {
          sectionMatches = true;
        }
      }
    }
  }

  // Flush last section
  flushSection();

  return matches;
};

export const createDocumentationTools = (
  options?: DocumentationToolsOptions
): ToolDefinition[] => {
  const docsDir = options?.docsDir ?? path.resolve(PROJECT_ROOT, "docs");
  const configDir = options?.configDir ?? path.resolve(PROJECT_ROOT, "config");

  return [
    {
      name: "query-documentation",
      description:
        "Search and read OpenZigs system documentation to answer user questions about features, configuration, architecture, tools, channels, scheduling, approval queue, and setup. Returns relevant sections — not entire files — to conserve context.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The topic to search for (e.g., 'approval queue', 'telegram setup', 'tool risk levels', 'webhooks', 'scheduling')",
          },
          file: {
            type: "string",
            enum: ["ARCHITECTURE", "USER_GUIDE", "TELEGRAM_SETUP", "CONFIG"],
            description:
              "Optional: specific documentation file to read. If omitted, all relevant files are searched.",
          },
        },
        required: ["topic"],
      },
      zodSchema: queryDocSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { topic, file } = args as z.infer<typeof queryDocSchema>;
        const keywords = topic
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 2);

        if (keywords.length === 0) {
          return { text: "Please provide a more specific topic to search for.", isError: true };
        }

        // Determine which files to search
        const filesToSearch = file
          ? [FILE_MAP[file]].filter(Boolean)
          : Object.values(FILE_MAP);

        const results: string[] = [];

        for (const entry of filesToSearch) {
          const dir = entry.dir === "docs" ? docsDir : configDir;
          const filePath = path.join(dir, entry.file);

          try {
            const content = await fs.readFile(filePath, "utf-8");

            if (entry.file.endsWith(".json")) {
              // For config files, return the entire content if any keyword matches
              const lower = content.toLowerCase();
              if (keywords.some((kw) => lower.includes(kw))) {
                results.push(
                  `## ${entry.file}\n\`\`\`json\n${content.slice(0, 2000)}\n\`\`\``
                );
              }
            } else {
              // For markdown files, extract matching sections
              const sections = searchMarkdownSections(content, keywords);
              if (sections.length > 0) {
                results.push(
                  `## From ${entry.file}\n\n${sections.slice(0, 5).join("\n\n---\n\n")}`
                );
              }
            }
          } catch {
            // File not found or unreadable — skip silently
          }
        }

        if (results.length === 0) {
          return {
            text: `No documentation found for topic "${topic}". Try broader terms or specify a file (ARCHITECTURE, USER_GUIDE, TELEGRAM_SETUP, CONFIG).`,
          };
        }

        return {
          text: `# Documentation Results for "${topic}"\n\n${results.join("\n\n")}`,
        };
      },
    },
  ];
};
