/**
 * Deterministic Tool Router — Issue #397
 *
 * Maps user intents to expected tool sequences via keyword/pattern matching.
 * Used by Tier 3A workflow routing tests to validate agentic behavior
 * without requiring LLM inference.
 */

export type RouteStep = {
  tool: string;
  expectedArgs: Record<string, unknown>;
};

type PatternRule = {
  patterns: RegExp[];
  route: (prompt: string) => RouteStep[];
};

const extractCharacterName = (prompt: string): string | null => {
  const match = prompt.match(/(?:character|my character|with)\s+(\w+)/i);
  return match?.[1] ?? null;
};

const rules: PatternRule[] = [
  // Scenario 1: Character LoRA video + music
  {
    patterns: [
      /video.*character|character.*video/i,
      /video.*music|music.*video/i,
    ],
    route: (prompt) => {
      const charName = extractCharacterName(prompt);
      const steps: RouteStep[] = [];

      if (charName) {
        steps.push({
          tool: "manage-characters",
          expectedArgs: { action: "get", id: expect.any(String) },
        });
      }

      steps.push({
        tool: "get-job-status",
        expectedArgs: { include_node_status: true },
      });

      steps.push({
        tool: "submit-media-job",
        expectedArgs: { type: "txt2video" },
      });

      if (/music|soundtrack|background/i.test(prompt)) {
        steps.push({
          tool: "submit-media-job",
          expectedArgs: { type: "txt2music" },
        });
      }

      steps.push({
        tool: "get-job-status",
        expectedArgs: { job_id: expect.any(String) },
      });

      return steps;
    },
  },

  // Scenario 2: Remix pipeline
  {
    patterns: [/remix/i, /replace.*stem|stem.*replace/i, /drum.*track|track.*drum/i],
    route: (prompt) => {
      const steps: RouteStep[] = [];

      steps.push({
        tool: "query-gallery-assets",
        expectedArgs: { type: "audio" },
      });

      steps.push({
        tool: "remix-session-manager",
        expectedArgs: { action: "analyze" },
      });

      const stemMatch = prompt.match(
        /(?:replace|swap|change)\s+(?:the\s+)?(\w+)\s+(?:with|to|into)\s+(\w+)/i,
      );
      if (stemMatch) {
        steps.push({
          tool: "remix-session-manager",
          expectedArgs: { action: "replace_stem", stem_name: stemMatch[1].toLowerCase() },
        });
      }

      steps.push({
        tool: "remix-session-manager",
        expectedArgs: { action: "master" },
      });

      return steps;
    },
  },

  // Scenario 3: Scheduled content pipeline
  {
    patterns: [/schedul|weekly|daily|cron|pipeline.*publish|publish.*pipeline/i],
    route: (_prompt) => {
      return [
        { tool: "list-secrets", expectedArgs: {} },
        { tool: "schedule-job", expectedArgs: { action: "list" } },
        { tool: "schedule-job", expectedArgs: { action: "create" } },
      ];
    },
  },

  // Image generation with character
  {
    patterns: [/(?:generate|create|make)\s+(?:a\s+)?(?:photo|image|picture)/i],
    route: (prompt) => {
      const steps: RouteStep[] = [];
      const charName = extractCharacterName(prompt);

      if (charName) {
        steps.push({
          tool: "manage-characters",
          expectedArgs: { action: "get", id: expect.any(String) },
        });
      }

      steps.push({
        tool: "submit-media-job",
        expectedArgs: { type: "txt2img" },
      });

      steps.push({
        tool: "get-job-status",
        expectedArgs: { job_id: expect.any(String) },
      });

      return steps;
    },
  },

  // Gallery search
  {
    patterns: [/find|show|list|search.*(?:media|image|video|audio|asset|gallery)/i],
    route: (_prompt) => {
      return [{ tool: "query-gallery-assets", expectedArgs: {} }];
    },
  },
];

/**
 * `expect.any(String)` sentinel for test assertions.
 * In test context, vitest/jest `expect.any(String)` is used.
 * Here we use a plain marker for structural matching.
 */
const expect = {
  any: (_ctor: unknown) => "__ANY__" as unknown,
  objectContaining: (partial: Record<string, unknown>) => partial as unknown,
};

/**
 * Route a user prompt to an expected tool call sequence.
 * Returns the first matching route, or an empty array if no match.
 */
export function routeToToolSequence(prompt: string): RouteStep[] {
  for (const rule of rules) {
    if (rule.patterns.some((p) => p.test(prompt))) {
      return rule.route(prompt);
    }
  }
  return [];
}
