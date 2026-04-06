import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSocialCaptionTools } from "./social-caption-tools.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import Database from "better-sqlite3";
import { OutboxRepository } from "../../outbox/outbox-repository.js";

function makeMockWrapper(response: string): CopilotWrapper {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield response;
    }),
  } as unknown as CopilotWrapper;
}

describe("Social Caption Tools", () => {
  let tools: ToolDefinition[];
  let mockCopilot: CopilotWrapper;

  beforeEach(() => {
    mockCopilot = makeMockWrapper(
      "Check out our latest post! 🚀 #tech #innovation #startup",
    );
    tools = createSocialCaptionTools({
      copilotWrapper: mockCopilot,
    });
  });

  it("should create 2 tools", () => {
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("generate-social-caption");
    expect(tools.map((t) => t.name)).toContain("generate-hashtags");
  });

  describe("generate-social-caption", () => {
    it("should generate a caption for twitter", async () => {
      const tool = tools.find((t) => t.name === "generate-social-caption")!;
      const result = await tool.handler({
        topic: "new product launch",
        platform: "twitter",
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.platform).toBe("twitter");
      expect(parsed.caption).toBeTruthy();
      expect(parsed.maxChars).toBe(280);
    });

    it("should handle missing copilot wrapper", async () => {
      const noLlmTools = createSocialCaptionTools({
        copilotWrapper: undefined,
      });
      const tool = noLlmTools.find(
        (t) => t.name === "generate-social-caption",
      )!;
      const result = await tool.handler({
        topic: "test",
        platform: "linkedin",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.caption).toContain("not available");
    });
  });

  describe("generate-hashtags", () => {
    it("should generate hashtags", async () => {
      const hashMock = makeMockWrapper(
        '[{"tag":"tech","category":"broad"},{"tag":"startup","category":"niche"}]',
      );
      const hashTools = createSocialCaptionTools({
        copilotWrapper: hashMock,
      });
      const tool = hashTools.find((t) => t.name === "generate-hashtags")!;
      const result = await tool.handler({
        topic: "AI startup",
        platform: "instagram",
        count: 5,
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.platform).toBe("instagram");
      expect(parsed.hashtags.length).toBeGreaterThan(0);
      expect(parsed.hashtags[0].tag).toMatch(/^#/);
    });
  });

  describe("caption-to-outbox flow (Issue #816)", () => {
    it("creates an outbox item when create_outbox_item is true", async () => {
      const db = new Database(":memory:");
      db.pragma("journal_mode = WAL");
      const outboxRepo = new OutboxRepository(db);
      outboxRepo.migrate();

      const toolsWithOutbox = createSocialCaptionTools({
        copilotWrapper: mockCopilot,
        outboxRepo,
      });
      const tool = toolsWithOutbox.find(
        (t) => t.name === "generate-social-caption",
      )!;
      const result = await tool.handler({
        topic: "new product launch",
        platform: "twitter",
        create_outbox_item: true,
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.outboxItemId).toBeDefined();

      // Verify the outbox item was created
      const item = outboxRepo.getById(parsed.outboxItemId);
      expect(item).not.toBeNull();
      expect(item!.platform).toBe("twitter");
      expect(item!.contentBody).toBe(parsed.caption);
      expect(item!.status).toBe("pending");
    });

    it("does not create outbox item when create_outbox_item is false", async () => {
      const db = new Database(":memory:");
      db.pragma("journal_mode = WAL");
      const outboxRepo = new OutboxRepository(db);
      outboxRepo.migrate();

      const toolsWithOutbox = createSocialCaptionTools({
        copilotWrapper: mockCopilot,
        outboxRepo,
      });
      const tool = toolsWithOutbox.find(
        (t) => t.name === "generate-social-caption",
      )!;
      const result = await tool.handler({
        topic: "test",
        platform: "twitter",
        create_outbox_item: false,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.outboxItemId).toBeUndefined();
    });

    it("does not create outbox item when outboxRepo is not provided", async () => {
      const toolsNoOutbox = createSocialCaptionTools({
        copilotWrapper: mockCopilot,
      });
      const tool = toolsNoOutbox.find(
        (t) => t.name === "generate-social-caption",
      )!;
      const result = await tool.handler({
        topic: "test",
        platform: "twitter",
        create_outbox_item: true,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.outboxItemId).toBeUndefined();
    });
  });
});
