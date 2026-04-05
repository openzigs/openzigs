/**
 * Voice Learning Service — Episodic memory for Social Brain.
 *
 * Stores approved/edited replies as few-shot examples in the knowledge base
 * (category: "voice_example", visibility: "internal") and retrieves the most
 * relevant examples at generation time via semantic similarity.
 *
 * This implements the "dynamic few-shot" pattern described in LangChain's
 * episodic memory docs: past approved replies become examples that teach the
 * model the user's preferred tone, phrasing, and style.
 */

import { logger } from "../../logging/logger.js";
import type { KnowledgeIngestionService } from "../../knowledge/index.js";

export type VoiceExample = {
  platform: string;
  username: string;
  originalMessage: string;
  approvedReply: string;
  wasEdited: boolean;
};

export type RecordVoiceExampleOpts = {
  messageId: string;
  platform: string;
  username: string;
  originalMessage: string;
  approvedReply: string;
  wasEdited: boolean;
};

export class VoiceLearningService {
  constructor(private knowledgeService: KnowledgeIngestionService) {}

  /**
   * Store an approved reply as a voice example in the knowledge base.
   * Called after a reply is approved or edited+approved.
   */
  async recordApprovedReply(opts: RecordVoiceExampleOpts): Promise<void> {
    const docId = `voice-example-${opts.messageId}`;
    const title = `Voice Example: Reply to @${opts.username} on ${opts.platform}`;

    // Structured text that embeds well for semantic search.
    // The "Context" field drives retrieval; the "Reply" field teaches style.
    const text = [
      `[Voice Example]`,
      `Platform: ${opts.platform}`,
      `To: @${opts.username}`,
      `Context: ${opts.originalMessage}`,
      `Reply: ${opts.approvedReply}`,
    ].join("\n");

    try {
      await this.knowledgeService.ingestText(docId, title, text, {
        visibility: "internal",
        category: "voice_example",
      });
      logger.info(
        `[VoiceLearning] Stored voice example ${docId} (edited=${opts.wasEdited})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `[VoiceLearning] Failed to store voice example ${docId}: ${msg}`,
      );
    }
  }

  /**
   * Retrieve voice examples similar to the given query.
   * Uses hybrid search (vector + FTS) over the voice_example category.
   */
  async getVoiceExamples(query: string, limit = 3): Promise<VoiceExample[]> {
    try {
      const results = await this.knowledgeService.search(query, limit, {
        mode: "hybrid",
        filter: { categories: ["voice_example"] },
      });

      return results
        .map((r) => this.parseVoiceExample(r.text))
        .filter((e): e is VoiceExample => e !== null);
    } catch {
      return [];
    }
  }

  /**
   * Get the total number of stored voice examples.
   */
  getExampleCount(): number {
    return this.knowledgeService
      .listDocuments()
      .filter((d) => d.id.startsWith("voice-example-")).length;
  }

  /**
   * Parse a structured voice example text back into a typed object.
   */
  private parseVoiceExample(text: string): VoiceExample | null {
    const platformMatch = text.match(/^Platform:\s*(.+)$/m);
    const usernameMatch = text.match(/^To:\s*@(.+)$/m);
    const contextMatch = text.match(/^Context:\s*(.+)$/m);
    const replyMatch = text.match(/^Reply:\s*([\s\S]+)$/m);

    if (!contextMatch || !replyMatch) return null;

    return {
      platform: platformMatch?.[1]?.trim() ?? "unknown",
      username: usernameMatch?.[1]?.trim() ?? "unknown",
      originalMessage: contextMatch[1].trim(),
      approvedReply: replyMatch[1].trim(),
      wasEdited: false, // not recoverable from text, but not needed at retrieval time
    };
  }

  /**
   * Format voice examples into a prompt block for few-shot injection.
   */
  static formatForPrompt(examples: VoiceExample[]): string {
    if (examples.length === 0) return "";

    const formatted = examples.map((ex, i) =>
      [
        `Example ${i + 1} (${ex.platform}, @${ex.username}):`,
        `  They said: ${ex.originalMessage}`,
        `  You replied: ${ex.approvedReply}`,
      ].join("\n"),
    );

    return [
      "## Your Past Approved Replies (match this tone and style)",
      ...formatted,
    ].join("\n\n");
  }
}
