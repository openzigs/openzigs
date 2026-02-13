import type { CopilotWrapperService } from "../copilot/copilot-wrapper.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { logger } from "../logging/logger.js";

export interface PromptAudit {
  originalPrompt: string;
  sessionId: string;
  score: number;
  tokenEstimate: number;
  suggestions: string;
  rewrite: string | null;
}

export interface PromptAuditResult {
  sampledCount: number;
  audits: PromptAudit[];
  averageScore: number;
}

export interface PromptAuditorDeps {
  copilot: CopilotWrapperService;
  sessionManager: SessionManager;
  model?: string;
}

const AUDITOR_SYSTEM_PROMPT = `You are a prompt efficiency auditor. Analyze the following user prompt and suggest improvements for clarity, token efficiency, and tool usage. Rate it 1-10 and provide a concrete rewrite if score < 7.

Respond ONLY in this exact JSON format:
{
  "score": <number 1-10>,
  "suggestions": "<string>",
  "rewrite": "<string or null>"
}`;

/**
 * Samples recent user prompts from session JSONL files and
 * sends them to a lightweight Copilot model for efficiency analysis.
 */
export class PromptAuditor {
  private copilot: CopilotWrapperService;
  private sessionManager: SessionManager;
  private model: string;

  constructor(deps: PromptAuditorDeps) {
    this.copilot = deps.copilot;
    this.sessionManager = deps.sessionManager;
    this.model = deps.model ?? "gpt-4o-mini";
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** Run audit: sample recent prompts and analyze them. */
  async audit(sampleSize = 5): Promise<PromptAuditResult> {
    const prompts = await this.sampleRecentPrompts(sampleSize);

    if (prompts.length === 0) {
      return { sampledCount: 0, audits: [], averageScore: 10 };
    }

    const audits: PromptAudit[] = [];

    for (const { prompt, sessionId } of prompts) {
      try {
        const audit = await this.analyzePrompt(prompt, sessionId);
        audits.push(audit);
      } catch (err) {
        logger.warn(`Sentinel prompt audit failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const averageScore = audits.length > 0
      ? audits.reduce((sum, a) => sum + a.score, 0) / audits.length
      : 10;

    return {
      sampledCount: audits.length,
      audits,
      averageScore,
    };
  }

  /** Sample random prompts from recent sessions. */
  private async sampleRecentPrompts(sampleSize: number): Promise<{ prompt: string; sessionId: string }[]> {
    try {
      const sessions = await this.sessionManager.listSessions();
      if (sessions.length === 0) return [];

      // Get recent sessions (last 24h or available)
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentSessions = sessions.filter((s) => new Date(s.lastActiveAt) > cutoff);
      const pool = recentSessions.length > 0 ? recentSessions : sessions.slice(0, 10);

      const prompts: { prompt: string; sessionId: string }[] = [];

      // Shuffle and sample
      const shuffled = [...pool].sort(() => Math.random() - 0.5);

      for (const session of shuffled) {
        if (prompts.length >= sampleSize) break;

        try {
          const events = await this.sessionManager.getHistory(session.id, 20);
          const userMessages = events.filter((e) => e.type === "user" && e.content.trim().length > 10);

          if (userMessages.length > 0) {
            // Pick a random user message
            const msg = userMessages[Math.floor(Math.random() * userMessages.length)];
            prompts.push({
              prompt: msg.content.slice(0, 500), // Truncate for safety
              sessionId: session.id,
            });
          }
        } catch {
          // Session history unavailable — skip
        }
      }

      return prompts;
    } catch {
      return [];
    }
  }

  /** Analyze a single prompt via Copilot. */
  private async analyzePrompt(prompt: string, sessionId: string): Promise<PromptAudit> {
    const userMessage = `Analyze this user prompt:\n\n"${prompt}"`;

    let response = "";
    for await (const chunk of this.copilot.chat(userMessage, {
      model: this.model,
      tools: [], // Pure analysis, no tool calls
      systemMessage: { mode: "replace" as const, content: AUDITOR_SYSTEM_PROMPT },
    })) {
      response += chunk;
    }

    // Parse JSON response
    const parsed = this.parseAuditResponse(response);

    return {
      originalPrompt: prompt.slice(0, 200),
      sessionId,
      score: parsed.score,
      tokenEstimate: Math.ceil(prompt.length / 4), // Rough token estimate
      suggestions: parsed.suggestions,
      rewrite: parsed.rewrite,
    };
  }

  /** Extract structured audit from the LLM response. */
  private parseAuditResponse(response: string): { score: number; suggestions: string; rewrite: string | null } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          score: typeof parsed.score === "number" ? Math.min(10, Math.max(1, parsed.score)) : 5,
          suggestions: typeof parsed.suggestions === "string" ? parsed.suggestions : "No specific suggestions.",
          rewrite: typeof parsed.rewrite === "string" ? parsed.rewrite : null,
        };
      }
    } catch {
      // Parse failed — return defaults
    }

    return {
      score: 5,
      suggestions: response.slice(0, 500),
      rewrite: null,
    };
  }
}
