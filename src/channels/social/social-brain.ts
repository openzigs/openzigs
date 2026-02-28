import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type { Contact, IncomingSocialMessage, SocialMessage, BrainResult } from "./types.js";
import type { CopilotWrapperService } from "../../copilot/copilot-wrapper.js";
import type { KnowledgeIngestionService } from "../../knowledge/index.js";

export type SocialBrainOptions = {
  repository: SocialRepository;
  copilot: CopilotWrapperService;
  knowledgeService: KnowledgeIngestionService;
  confidenceThreshold?: "high" | "medium" | "low";
  systemPrompt?: string;
  /** Brand voice prompt block injected into the system prompt for stylistic consistency */
  brandVoiceBlock?: string;
};

const DEFAULT_SYSTEM_PROMPT = `You are a helpful social media assistant. You respond to direct messages from users.
Use the provided context from the knowledge base to answer questions accurately.
If post context is provided, use it to understand what the user is referring to.
If you are not confident in your answer, say so honestly.

Instructions:
- Be concise and friendly
- Match the platform's communication style (informal for Instagram/TikTok, slightly more formal for LinkedIn)
- If the user is asking about a specific post, use the post caption and details to inform your reply
- If you cannot answer the question from the available context, set confidence to "low"
- Always respond in the same language the user writes in

Respond in JSON format:
{
  "reply": "Your response text",
  "confidence": "high" | "medium" | "low",
  "intent": "brief description of what the user wants"
}`;

/**
 * The Social Brain: processes inbound social messages through a RAG pipeline
 * (CRM lookup → knowledge retrieval → LLM generation) and produces replies.
 *
 * Emits:
 * - "reply" — { contact, message, result: BrainResult }
 * - "escalate" — { contact, message, result: BrainResult }
 */
export class SocialBrain extends EventEmitter {
  private repository: SocialRepository;
  private copilot: CopilotWrapperService;
  private knowledgeService: KnowledgeIngestionService;
  private confidenceThreshold: "high" | "medium" | "low";
  private systemPrompt!: string;
  private baseSystemPrompt: string;
  private brandVoiceBlock: string;

  constructor(opts: SocialBrainOptions) {
    super();
    this.repository = opts.repository;
    this.copilot = opts.copilot;
    this.knowledgeService = opts.knowledgeService;
    this.confidenceThreshold = opts.confidenceThreshold ?? "medium";
    this.brandVoiceBlock = opts.brandVoiceBlock ?? "";
    this.baseSystemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.rebuildSystemPrompt();
  }

  /** Update the brand voice block used in system prompts at runtime. */
  setBrandVoice(block: string): void {
    this.brandVoiceBlock = block;
    this.rebuildSystemPrompt();
  }

  private rebuildSystemPrompt(): void {
    this.systemPrompt = this.brandVoiceBlock
      ? `${this.baseSystemPrompt}\n\n${this.brandVoiceBlock}`
      : this.baseSystemPrompt;
  }

  /**
   * Process an inbound message through the Brain pipeline.
   * Returns the BrainResult (or null if skipped due to handoff).
   */
  async process(contact: Contact, message: SocialMessage, raw: IncomingSocialMessage): Promise<BrainResult | null> {
    // 1. Check if contact is in handoff state — skip Brain
    if (contact.handoff_active) {
      this.emit("escalated_message", { contact, message, raw });
      return null;
    }

    try {
      // 2. RAG retrieval from knowledge base
      const ragChunks = await this.searchKnowledge(raw.text);
      const ragContext = ragChunks.length > 0
        ? ragChunks.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")
        : "(No relevant knowledge base context found)";

      // 3. Build conversation context (last 5 messages)
      const history = this.repository.getMessages(contact.id, 5);
      const conversationContext = history
        .reverse()
        .map((m) => `${m.direction === "inbound" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      // 3b. Extract post context from recent outbound DMs (comment-rule-engine stores it in metadata)
      let postContextBlock = "";
      for (const m of history) {
        try {
          const meta = JSON.parse(m.metadata) as Record<string, unknown>;
          if (meta.postCaption || meta.postUrl) {
            postContextBlock = [
              "Related post context (the user interacted with this post):",
              meta.postCaption ? `  Caption: ${meta.postCaption}` : "",
              meta.postUrl ? `  URL: ${meta.postUrl}` : "",
              meta.postMediaType ? `  Media type: ${meta.postMediaType}` : "",
              meta.triggeringComment ? `  Their comment: ${meta.triggeringComment}` : "",
            ].filter(Boolean).join("\n");
            break; // use most recent post context
          }
        } catch { /* not JSON, skip */ }
      }

      // 4. Compose prompt
      const userPrompt = [
        `Platform: ${raw.platform}`,
        `Username: @${raw.username}`,
        `Contact tags: ${contact.tags}`,
        "",
        "Recent conversation:",
        conversationContext || "(first message)",
        "",
        postContextBlock || "(no post context)",
        "",
        "Knowledge base context:",
        ragContext,
        "",
        `New message from user: ${raw.text}`,
      ].join("\n");

      // 5. LLM generation
      const result = await this.generateReply(userPrompt);

      // 6. Decide action based on confidence
      const shouldEscalate = this.shouldEscalate(result);

      const brainResult: BrainResult = {
        ...result,
        ragChunksUsed: ragChunks,
        shouldEscalate,
      };

      if (shouldEscalate) {
        // Update message status to escalated
        this.emit("escalate", { contact, message, result: brainResult, raw });
      } else {
        // Log auto-reply in messages table
        this.repository.insertMessage({
          contactId: contact.id,
          platform: raw.platform,
          direction: "outbound",
          status: "auto_replied",
          content: result.reply,
          metadata: { confidence: result.confidence, intent: result.intent },
        });
        this.emit("reply", { contact, message, result: brainResult, raw });
      }

      return brainResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SocialBrain] Processing failed for contact ${contact.id}: ${msg}`);
      return {
        reply: "",
        confidence: "low",
        intent: "error",
        ragChunksUsed: [],
        shouldEscalate: true,
      };
    }
  }

  private async searchKnowledge(query: string): Promise<string[]> {
    try {
      const results = await this.knowledgeService.search(query, 5, { mode: "hybrid" });
      return results.map((r) => r.text);
    } catch {
      return [];
    }
  }

  private async generateReply(prompt: string): Promise<{ reply: string; confidence: "high" | "medium" | "low"; intent: string }> {
    let fullResponse = "";
    const conversationId = `social-brain-${Date.now()}`;

    for await (const chunk of this.copilot.chat(prompt, {
      conversationId,
      systemMessage: { mode: "replace", content: this.systemPrompt },
    })) {
      fullResponse += chunk;
    }

    // Destroy the ephemeral session
    await this.copilot.destroySession(conversationId);

    // Parse JSON response
    try {
      // Extract JSON from response (may be wrapped in markdown code block)
      const jsonMatch = fullResponse.match(/\{[\s\S]*?"reply"[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { reply?: string; confidence?: string; intent?: string };
        return {
          reply: parsed.reply ?? fullResponse,
          confidence: (["high", "medium", "low"].includes(parsed.confidence ?? "")
            ? parsed.confidence as "high" | "medium" | "low"
            : "medium"),
          intent: parsed.intent ?? "unknown",
        };
      }
    } catch {
      // Fall through to raw response
    }

    // Fallback: treat entire response as the reply
    return { reply: fullResponse, confidence: "medium", intent: "unknown" };
  }

  private shouldEscalate(result: { confidence: string }): boolean {
    const levels = ["high", "medium", "low"];
    const confidenceIndex = levels.indexOf(result.confidence);
    const thresholdIndex = levels.indexOf(this.confidenceThreshold);
    // Escalate if confidence is lower than threshold
    return confidenceIndex > thresholdIndex;
  }
}
