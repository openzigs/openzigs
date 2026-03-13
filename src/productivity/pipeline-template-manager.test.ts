import { describe, it, expect, vi, beforeEach } from "vitest";
import { PipelineTemplateManager } from "./pipeline-template-manager.js";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import fs from "node:fs/promises";

const BUILT_IN = [
  {
    id: "research-and-summarize",
    name: "Research & Summarize",
    description: "Research then summarize",
    icon: "🔬",
    tags: ["research"],
    suggestedSkill: null,
    template: "Research {{topic}}",
    stages: [{ name: "research", prompt: "Research {{topic}}", tools: ["web-search"] }],
    variables: [{ key: "topic", label: "Topic", description: "Research topic", required: true }],
  },
];

describe("PipelineTemplateManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads built-in templates", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(BUILT_IN)) // built-in
      .mockRejectedValueOnce(new Error("ENOENT")); // user (not found)

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Research & Summarize");
    expect(list[0].builtIn).toBe(true);
  });

  it("merges built-in and user templates", async () => {
    const userTemplate = { id: "custom-1", name: "Custom", description: "", icon: "📋", tags: [], suggestedSkill: null, template: "", stages: [], variables: [] };
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(BUILT_IN))
      .mockResolvedValueOnce(JSON.stringify([userTemplate]));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    expect(mgr.list()).toHaveLength(2);
    expect(mgr.list()[0].builtIn).toBe(true);
    expect(mgr.list()[1].builtIn).toBe(false);
  });

  it("getById returns matching template", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(BUILT_IN))
      .mockRejectedValueOnce(new Error("ENOENT"));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    expect(mgr.getById("research-and-summarize")?.name).toBe("Research & Summarize");
    expect(mgr.getById("nonexistent")).toBeNull();
  });

  it("creates a user template and saves to disk", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockRejectedValueOnce(new Error("ENOENT"));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    const created = await mgr.create({
      name: "New Template",
      description: "test",
      icon: "🆕",
      tags: ["test"],
      suggestedSkill: null,
      template: "Do {{thing}}",
      stages: [{ name: "step1", prompt: "Do {{thing}}" }],
      variables: [{ key: "thing", label: "Thing", description: "What to do", required: true }],
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe("New Template");
    expect(created.builtIn).toBe(false);
    expect(fs.writeFile).toHaveBeenCalled();
    expect(mgr.list()).toHaveLength(1);
  });

  it("updates a user template", async () => {
    const userTemplate = { id: "u1", name: "Old Name", description: "", icon: "📋", tags: [], suggestedSkill: null, template: "", stages: [], variables: [] };
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify([userTemplate]));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    const updated = await mgr.update("u1", { name: "New Name" });
    expect(updated?.name).toBe("New Name");
    expect(fs.writeFile).toHaveBeenCalled();
  });

  it("update returns null for unknown id", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockRejectedValueOnce(new Error("ENOENT"));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    expect(await mgr.update("nonexistent", { name: "X" })).toBeNull();
  });

  it("removes a user template", async () => {
    const userTemplate = { id: "u1", name: "Temp", description: "", icon: "📋", tags: [], suggestedSkill: null, template: "", stages: [], variables: [] };
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify([userTemplate]));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    expect(await mgr.remove("u1")).toBe(true);
    expect(mgr.list()).toHaveLength(0);
    expect(fs.writeFile).toHaveBeenCalled();
  });

  it("remove returns false for unknown id", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockRejectedValueOnce(new Error("ENOENT"));

    const mgr = new PipelineTemplateManager("/config/pipeline-templates.json");
    await mgr.load();

    expect(await mgr.remove("nonexistent")).toBe(false);
  });
});
