import { logger } from "../logging/logger.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import { BrandVoiceRepository } from "./brand-voice-repository.js";
import type { BrandVoice, BrandVoiceRulebook } from "./brand-voice-repository.js";

const LINGUISTIC_PROFILER_SYSTEM_PROMPT = `You are an elite Linguistic Profiler and forensic copywriter. Your job is to analyze the provided writing samples and extract the absolute DNA of the author's voice so another AI can perfectly mimic them.

Look past the subject matter and focus entirely on the *mechanics* of the writing.
- How do they transition between ideas?
- What is their rhythm (staccato vs. flowing)?
- Do they use rhetorical questions?
- Are they formal, conversational, empathetic, or blunt?

You MUST explicitly ban standard, overused AI vocabulary. Under the \`banned_words\` array, automatically include: 'delve', 'tapestry', 'testament', 'buckle up', 'unlock', 'unleash', 'supercharge', 'dive in', 'landscape', and 'realm', plus any words that clash with the user's specific samples.

Respond ONLY with valid JSON matching this exact schema (no markdown fencing, no commentary):
{
  "tone": "Short vibe descriptor",
  "sentence_structure": "Pacing & length descriptor",
  "vocabulary_level": "Word choice descriptor",
  "formatting_quirks": "How they use bolding, bullet points, paragraphs",
  "banned_words": ["array", "of", "banned", "words"]
}`;

export interface BrandVoiceServiceOptions {
  repository: BrandVoiceRepository;
  copilot: CopilotWrapper;
}

export class BrandVoiceService {
  private repository: BrandVoiceRepository;
  private copilot: CopilotWrapper;

  constructor({ repository, copilot }: BrandVoiceServiceOptions) {
    this.repository = repository;
    this.copilot = copilot;
  }

  /**
   * Analyze writing samples via the Linguistic Profiler LLM prompt and
   * return a structured BrandVoiceRulebook.
   */
  async analyzeWritingStyle(samples: string[], model?: string): Promise<BrandVoiceRulebook> {
    if (samples.length === 0) {
      throw new Error("At least one writing sample is required");
    }

    const samplesBlock = samples
      .map((s, i) => `--- SAMPLE ${i + 1} ---\n${s}`)
      .join("\n\n");

    const userPrompt = `Analyze these writing samples and extract the brand voice rulebook:\n\n${samplesBlock}`;

    logger.info(`[BrandVoiceService] Analyzing ${samples.length} writing sample(s)…`);

    const chunks: string[] = [];
    const conversationId = `brand-voice-analysis-${Date.now()}`;

    for await (const chunk of this.copilot.chat(userPrompt, {
      conversationId,
      systemMessage: { mode: "replace", content: LINGUISTIC_PROFILER_SYSTEM_PROMPT },
      tools: [],
      ...(model ? { model } : {}),
    })) {
      chunks.push(chunk);
    }

    await this.copilot.destroySession(conversationId);

    const responseText = chunks.join("");

    // Parse JSON from response (may be wrapped in markdown code block)
    const rulebook = this.parseRulebook(responseText);

    logger.info(`[BrandVoiceService] Analysis complete: tone="${rulebook.tone}", ${rulebook.banned_words.length} banned words`);

    return rulebook;
  }

  /**
   * Analyze writing samples and save the result as a new brand voice.
   */
  async analyzeAndSave(
    name: string,
    samples: string[],
    options?: { active?: boolean; model?: string },
  ): Promise<BrandVoice> {
    const rulebook = await this.analyzeWritingStyle(samples, options?.model);
    return this.repository.create({
      name,
      rulebook,
      samples,
      active: options?.active,
    });
  }

  getActive(): BrandVoice | null {
    return this.repository.getActive();
  }

  getAll(): BrandVoice[] {
    return this.repository.getAll();
  }

  getById(id: string): BrandVoice | null {
    return this.repository.getById(id);
  }

  setActive(id: string): BrandVoice | null {
    return this.repository.setActive(id);
  }

  deactivateAll(): void {
    this.repository.deactivateAll();
  }

  update(id: string, input: { name?: string; rulebook?: BrandVoiceRulebook; active?: boolean; samples?: string[] }): BrandVoice | null {
    return this.repository.update(id, input);
  }

  /**
   * Re-analyze writing samples for an existing brand voice.
   * Updates both the rulebook and samples on the existing record.
   */
  async reanalyze(id: string, samples: string[], model?: string): Promise<BrandVoice | null> {
    const existing = this.repository.getById(id);
    if (!existing) return null;

    const rulebook = await this.analyzeWritingStyle(samples, model);
    return this.repository.update(id, { rulebook, samples });
  }

  delete(id: string): boolean {
    return this.repository.delete(id);
  }

  /**
   * Build a brand-voice instruction block suitable for injection into any system prompt.
   * Returns empty string if no active brand voice.
   */
  getActiveVoicePromptBlock(): string {
    const active = this.repository.getActive();
    if (!active) return "";
    return this.buildPromptBlock(active.rulebook);
  }

  /**
   * Build a brand-voice instruction block for a specific voice by ID.
   * Falls back to the active voice if id is not provided, or returns empty string.
   */
  getVoicePromptBlockById(id?: string | null): string {
    if (!id) return this.getActiveVoicePromptBlock();
    const voice = this.repository.getById(id);
    if (!voice) return this.getActiveVoicePromptBlock();
    return this.buildPromptBlock(voice.rulebook);
  }

  /**
   * Build a prompt block from a specific rulebook.
   */
  buildPromptBlock(rulebook: BrandVoiceRulebook): string {
    return `
BRAND VOICE RULES (follow these strictly for all generated content):
- Tone: ${rulebook.tone}
- Sentence Structure: ${rulebook.sentence_structure}
- Vocabulary Level: ${rulebook.vocabulary_level}
- Formatting Quirks: ${rulebook.formatting_quirks}
- BANNED WORDS (never use these): ${rulebook.banned_words.join(", ")}
`.trim();
  }

  private parseRulebook(responseText: string): BrandVoiceRulebook {
    // Try extracting JSON from markdown code block first
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : responseText.trim();

    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      const tone = typeof parsed.tone === "string" ? parsed.tone : "";
      const sentence_structure = typeof parsed.sentence_structure === "string" ? parsed.sentence_structure : "";
      const vocabulary_level = typeof parsed.vocabulary_level === "string" ? parsed.vocabulary_level : "";
      const formatting_quirks = typeof parsed.formatting_quirks === "string" ? parsed.formatting_quirks : "";
      const banned_words = Array.isArray(parsed.banned_words)
        ? (parsed.banned_words as unknown[]).filter((w): w is string => typeof w === "string")
        : [];

      if (!tone && !sentence_structure) {
        throw new Error("Parsed JSON is missing required fields (tone, sentence_structure)");
      }

      return { tone, sentence_structure, vocabulary_level, formatting_quirks, banned_words };
    } catch (err) {
      // Try to find any JSON object in the response
      const jsonMatch = responseText.match(/\{[\s\S]*?"tone"[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const fallback = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          return {
            tone: typeof fallback.tone === "string" ? fallback.tone : "",
            sentence_structure: typeof fallback.sentence_structure === "string" ? fallback.sentence_structure : "",
            vocabulary_level: typeof fallback.vocabulary_level === "string" ? fallback.vocabulary_level : "",
            formatting_quirks: typeof fallback.formatting_quirks === "string" ? fallback.formatting_quirks : "",
            banned_words: Array.isArray(fallback.banned_words)
              ? (fallback.banned_words as unknown[]).filter((w): w is string => typeof w === "string")
              : [],
          };
        } catch { /* fall through */ }
      }

      throw new Error(
        `Failed to parse brand voice analysis response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
