import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceLearningService, type VoiceExample } from "./voice-learning.js";
import type { KnowledgeIngestionService } from "../../knowledge/index.js";

function makeMockKnowledge() {
  return {
    search: vi.fn().mockResolvedValue([]),
    ingestText: vi.fn().mockResolvedValue(undefined),
    listDocuments: vi.fn().mockReturnValue([]),
  } as unknown as KnowledgeIngestionService;
}

describe("VoiceLearningService", () => {
  let knowledge: ReturnType<typeof makeMockKnowledge>;
  let service: VoiceLearningService;

  beforeEach(() => {
    knowledge = makeMockKnowledge();
    service = new VoiceLearningService(knowledge);
  });

  describe("recordApprovedReply", () => {
    it("stores an approved reply as a voice_example document", async () => {
      await service.recordApprovedReply({
        messageId: "msg-123",
        platform: "twitter",
        username: "johndoe",
        originalMessage: "How much does this cost?",
        approvedReply: "Hey! Our starter plan is $29/mo.",
        wasEdited: false,
      });

      expect(knowledge.ingestText).toHaveBeenCalledTimes(1);
      const [docId, title, text, opts] = (knowledge.ingestText as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(docId).toBe("voice-example-msg-123");
      expect(title).toContain("@johndoe");
      expect(title).toContain("twitter");
      expect(text).toContain("Context: How much does this cost?");
      expect(text).toContain("Reply: Hey! Our starter plan is $29/mo.");
      expect(opts).toEqual({ visibility: "internal", category: "voice_example" });
    });

    it("does not throw on ingest failure", async () => {
      (knowledge.ingestText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));

      await expect(service.recordApprovedReply({
        messageId: "msg-456",
        platform: "reddit",
        username: "alice",
        originalMessage: "What's your return policy?",
        approvedReply: "30-day no-questions-asked returns.",
        wasEdited: true,
      })).resolves.toBeUndefined();
    });
  });

  describe("getVoiceExamples", () => {
    it("returns parsed examples from knowledge search", async () => {
      (knowledge.search as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          text: "[Voice Example]\nPlatform: twitter\nTo: @johndoe\nContext: How much does this cost?\nReply: Hey! Our starter plan is $29/mo.",
          score: 0.85,
        },
        {
          text: "[Voice Example]\nPlatform: linkedin\nTo: @jane\nContext: Do you offer enterprise plans?\nReply: Absolutely! Let me connect you with our sales team.",
          score: 0.72,
        },
      ]);

      const examples = await service.getVoiceExamples("pricing question", 3);

      expect(knowledge.search).toHaveBeenCalledWith("pricing question", 3, {
        mode: "hybrid",
        filter: { categories: ["voice_example"] },
      });
      expect(examples).toHaveLength(2);
      expect(examples[0]).toEqual({
        platform: "twitter",
        username: "johndoe",
        originalMessage: "How much does this cost?",
        approvedReply: "Hey! Our starter plan is $29/mo.",
        wasEdited: false,
      });
      expect(examples[1].platform).toBe("linkedin");
      expect(examples[1].username).toBe("jane");
    });

    it("returns empty array on search failure", async () => {
      (knowledge.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("search error"));

      const examples = await service.getVoiceExamples("anything");
      expect(examples).toEqual([]);
    });

    it("skips unparseable results", async () => {
      (knowledge.search as ReturnType<typeof vi.fn>).mockResolvedValue([
        { text: "some random text without voice example format", score: 0.5 },
        {
          text: "[Voice Example]\nPlatform: reddit\nTo: @bob\nContext: Nice post\nReply: Thanks!",
          score: 0.6,
        },
      ]);

      const examples = await service.getVoiceExamples("test");
      expect(examples).toHaveLength(1);
      expect(examples[0].platform).toBe("reddit");
    });
  });

  describe("getExampleCount", () => {
    it("counts documents with voice-example prefix", () => {
      (knowledge.listDocuments as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "voice-example-msg-1" },
        { id: "voice-example-msg-2" },
        { id: "some-other-doc" },
      ]);

      expect(service.getExampleCount()).toBe(2);
    });
  });

  describe("formatForPrompt", () => {
    it("formats examples as a few-shot prompt block", () => {
      const examples: VoiceExample[] = [
        {
          platform: "twitter",
          username: "alice",
          originalMessage: "What hours are you open?",
          approvedReply: "We're open 9-5 EST, Monday through Friday!",
          wasEdited: false,
        },
        {
          platform: "linkedin",
          username: "bob",
          originalMessage: "Do you offer consulting?",
          approvedReply: "Yes! We offer strategy consulting. Want me to send details?",
          wasEdited: true,
        },
      ];

      const block = VoiceLearningService.formatForPrompt(examples);

      expect(block).toContain("Your Past Approved Replies");
      expect(block).toContain("Example 1 (twitter, @alice):");
      expect(block).toContain("They said: What hours are you open?");
      expect(block).toContain("You replied: We're open 9-5 EST");
      expect(block).toContain("Example 2 (linkedin, @bob):");
    });

    it("returns empty string when no examples", () => {
      expect(VoiceLearningService.formatForPrompt([])).toBe("");
    });
  });
});
