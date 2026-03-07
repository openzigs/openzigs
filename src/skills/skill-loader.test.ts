import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import fs from "node:fs/promises";
import { loadSkillMetadata } from "./skill-loader.js";

const readFileMock = vi.mocked(fs.readFile);

const MEDIA_DIRECTOR_MD = `---
name: media-director
description: Orchestrates image generation and video production. Use when creating visual content.
allowed-tools: query-gallery-assets submit-media-job get-job-status manage-characters schedule-job
---

# Skill: Media Director

## Identity
You are the OpenZigs Media Director — an expert in visual content creation.

## Domain Rules
1. Default to flux-schnell model.
2. Always check character LoRAs first.
3. Standard resolutions: 1024x1024.
4. For img2img, verify the source exists.
`;

const NO_FRONTMATTER_MD = `# Skill: Legacy

## Identity
This is a legacy skill without YAML frontmatter.

## Rules
1. First rule.
2. Second rule.
`;

describe("skill-loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses YAML frontmatter and extracts name, description, and allowed-tools", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);

    expect(result).toHaveLength(1);
    const skill = result[0];
    expect(skill.name).toBe("media-director");
    expect(skill.description).toBe(
      "Orchestrates image generation and video production. Use when creating visual content."
    );
    expect(skill.allowedTools).toEqual([
      "query-gallery-assets",
      "submit-media-job",
      "get-job-status",
      "manage-characters",
      "schedule-job",
    ]);
    expect(skill.tools).toEqual(skill.allowedTools);
  });

  it("falls back to extracting description from body when no frontmatter", async () => {
    readFileMock.mockResolvedValue(NO_FRONTMATTER_MD);

    const result = await loadSkillMetadata(["/fake/skills/legacy"]);

    expect(result).toHaveLength(1);
    const skill = result[0];
    expect(skill.name).toBe("legacy");
    expect(skill.allowedTools).toEqual([]);
    expect(skill.description).toBe("This is a legacy skill without YAML frontmatter.");
  });

  it("uses directory name when frontmatter name is missing", async () => {
    const mdWithoutName = `---
description: A test skill.
---

# Test Skill

## Identity
You are a test skill.
`;
    readFileMock.mockResolvedValue(mdWithoutName);

    const result = await loadSkillMetadata(["/fake/skills/test-skill"]);
    expect(result[0].name).toBe("test-skill");
    expect(result[0].displayName).toBe("Test Skill");
  });

  it("counts numbered rules correctly", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);
    expect(result[0].rulesCount).toBe(4);
  });

  it("includes content when includeContent is true", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"], true);
    expect(result[0].content).toBe(MEDIA_DIRECTOR_MD);
  });

  it("excludes content by default", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);
    expect(result[0].content).toBeUndefined();
  });

  it("skips unreadable directories", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    const result = await loadSkillMetadata(["/fake/skills/missing"]);
    expect(result).toEqual([]);
  });

  it("loads multiple skills", async () => {
    readFileMock
      .mockResolvedValueOnce(MEDIA_DIRECTOR_MD)
      .mockResolvedValueOnce(NO_FRONTMATTER_MD);

    const result = await loadSkillMetadata([
      "/fake/skills/media-director",
      "/fake/skills/legacy",
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("media-director");
    expect(result[1].name).toBe("legacy");
  });

  it("maps known icons correctly", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);
    expect(result[0].icon).toBe("\u{1F3AC}");
  });

  it("falls back to robot icon for unknown skill names", async () => {
    readFileMock.mockResolvedValue(NO_FRONTMATTER_MD);

    const result = await loadSkillMetadata(["/fake/skills/unknown-skill"]);
    expect(result[0].icon).toBe("\u{1F916}");
  });

  it("extracts examples for known skills", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);
    expect(result[0].examples.length).toBeGreaterThan(0);
    expect(result[0].examples[0]).toContain("cyberpunk");
  });

  it("provides skillMdPath relative to cwd", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);
    expect(result[0].skillMdPath).toContain("SKILL.md");
  });

  it("marks all loaded skills as loaded: true", async () => {
    readFileMock.mockResolvedValue(MEDIA_DIRECTOR_MD);

    const result = await loadSkillMetadata(["/fake/skills/media-director"]);
    expect(result[0].loaded).toBe(true);
  });
});
