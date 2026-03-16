import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../project-root.js";

export interface SkillMetadata {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  tools: string[];
  rulesCount: number;
  loaded: boolean;
  examples: string[];
  skillMdPath: string;
  allowedTools: string[];
  content?: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  "allowed-tools"?: string;
  license?: string;
  compatibility?: string;
}

const SKILL_ICONS: Record<string, string> = {
  "media-director": "\u{1F3AC}",
  "remix-engineer": "\u{1F3B5}",
  "platform-manager": "\u{1F4E1}",
  "content-creator": "\u{270D}\uFE0F",
  "knowledge-curator": "\u{1F4DA}",
  "system-operator": "\u{1F6E1}\uFE0F",
  "pinterest-marketer": "\u{1F4CC}",
  "research-synthesizer": "\u{1F52C}",
  "universal-publisher": "\u{1F4E4}",
};

const SKILL_EXAMPLES: Record<string, string[]> = {
  "media-director": [
    "Create a 4-second cyberpunk cityscape video",
    "Generate a thumbnail with character Alex",
    "Show me all generated images from this week",
  ],
  "remix-engineer": [
    "Remix my latest track — replace the drums with strings",
    "Analyze the stems of yesterday's upload",
    "Master the remix with a warm lofi vibe",
  ],
  "platform-manager": [
    "Schedule a weekly motivational post for Twitter",
    "Publish the latest gallery image to Twitter",
    "List all scheduled automation jobs",
  ],
  "content-creator": [
    "Convert this blog post to a narrated video",
    "Create a YouTube Short from the last video",
    "Generate a voiceover using the warm female voice",
  ],
  "knowledge-curator": [
    "Ingest this article into the knowledge base",
    "Search for content about machine learning",
    "Generate a quiz for the latest presentation",
  ],
  "system-operator": [
    "Check the health of all worker nodes",
    "Show me the latest Sentinel digest",
    "Create a webhook for CI/CD deployments",
  ],
  "pinterest-marketer": [
    "Find trending Pinterest keywords and create optimized pins",
    "Audit my top pins for SEO and annotation coverage",
    "Repurpose this blog post as Pinterest content",
  ],
  "research-synthesizer": [
    "Research the top AI coding assistants in 2026 with 8 web articles and 5 YouTube videos",
    "Compare cloud hosting providers from a cost perspective and generate comparison images",
    "Write a comprehensive report on renewable energy trends using web and YouTube sources",
  ],
  "universal-publisher": [
    "Publish the next queued outbox item",
    "Post the latest gallery image to Twitter with hashtags",
    "Publish all pending outbox items for Pinterest",
  ],
};

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();
  const fm: Frontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
    else if (key === "allowed-tools") fm["allowed-tools"] = val;
    else if (key === "license") fm.license = val;
    else if (key === "compatibility") fm.compatibility = val;
  }
  return { frontmatter: fm, body };
}

function extractDescriptionFromBody(body: string): string {
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("You are") || trimmed.startsWith("You're")) {
      return trimmed.replace(/^You are the OpenZigs /, "").replace(/^You are /, "");
    }
  }
  const identityIdx = lines.findIndex((l) => l.trim().startsWith("## Identity"));
  if (identityIdx !== -1 && identityIdx + 1 < lines.length) {
    for (let i = identityIdx + 1; i < Math.min(identityIdx + 5, lines.length); i++) {
      const trimmed = lines[i].trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return trimmed.replace(/^You are the OpenZigs /, "").replace(/^You are /, "");
      }
    }
  }
  return "AI skill persona for OpenZigs";
}

function countRules(content: string): number {
  const numbered = content.match(/^\d+\.\s/gm);
  return numbered?.length ?? 0;
}

function toDisplayName(dirName: string): string {
  return dirName
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export async function loadSkillMetadata(
  skillDirectories: string[],
  includeContent = false,
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];

  for (const dir of skillDirectories) {
    const skillMdPath = path.join(dir, "SKILL.md");
    try {
      const raw = await fs.readFile(skillMdPath, "utf-8");
      const dirName = path.basename(dir);
      const { frontmatter, body } = parseFrontmatter(raw);

      const allowedTools = frontmatter["allowed-tools"]
        ? frontmatter["allowed-tools"].split(/\s+/).filter(Boolean)
        : [];

      const description = frontmatter.description || extractDescriptionFromBody(body);

      skills.push({
        name: frontmatter.name || dirName,
        displayName: toDisplayName(frontmatter.name || dirName),
        description,
        icon: SKILL_ICONS[dirName] ?? "\u{1F916}",
        tools: allowedTools,
        allowedTools,
        rulesCount: countRules(body),
        loaded: true,
        examples: SKILL_EXAMPLES[dirName] ?? [],
        skillMdPath: path.relative(PROJECT_ROOT, skillMdPath),
        ...(includeContent ? { content: raw } : {}),
      });
    } catch {
      // SKILL.md not found or unreadable — skip
    }
  }

  return skills;
}
