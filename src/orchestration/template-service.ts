import type { TemplateRepository } from "./template-repository.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type {
  OrchestrationTemplate,
  CreateOrchestrationTemplateInput,
  OrchestrationMode,
} from "./types.js";
import {
  CreateOrchestrationTemplateSchema,
  UpdateOrchestrationTemplateSchema,
  ExecuteTemplateSchema,
  TemplateNotFoundError,
} from "./types.js";
import { logger } from "../logging/logger.js";

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Extract {{variable}} names from a string. */
export function extractVariables(text: string): string[] {
  const matches = new Set<string>();
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
    matches.add(m[1]);
  }
  return [...matches];
}

/** Replace {{variable}} placeholders with values. */
export function interpolateTemplate(
  text: string,
  variables: Record<string, string>
): string {
  return text.replace(VARIABLE_PATTERN, (_, name: string) => {
    return variables[name] ?? `{{${name}}}`;
  });
}

export type TemplateServiceOptions = {
  repository: TemplateRepository;
  taskEngine?: TaskEngine;
  copilot?: CopilotWrapper;
};

export class TemplateService {
  private repo: TemplateRepository;
  private taskEngine?: TaskEngine;
  private copilot?: CopilotWrapper;

  constructor(opts: TemplateServiceOptions) {
    this.repo = opts.repository;
    this.taskEngine = opts.taskEngine;
    this.copilot = opts.copilot;
  }

  /** Deferred injection — call after CopilotWrapper is initialised. */
  setCopilot(copilot: CopilotWrapper): void {
    this.copilot = copilot;
  }

  create(input: unknown): OrchestrationTemplate {
    const parsed = CreateOrchestrationTemplateSchema.parse(input);
    return this.repo.insert(parsed);
  }

  list(): OrchestrationTemplate[] {
    return this.repo.list();
  }

  getById(id: string): OrchestrationTemplate | null {
    return this.repo.getById(id);
  }

  update(id: string, input: unknown): OrchestrationTemplate | null {
    const existing = this.repo.getById(id);
    if (!existing) return null;
    const parsed = UpdateOrchestrationTemplateSchema.parse(input);
    return this.repo.update(id, parsed);
  }

  delete(id: string): boolean {
    const existing = this.repo.getById(id);
    if (!existing) return false;
    if (existing.isBuiltIn) {
      throw new Error("Cannot delete built-in templates");
    }
    return this.repo.delete(id);
  }

  /**
   * Execute a template by interpolating variables and submitting tasks.
   * Returns the created task IDs, or a sessionResponse when using session mode.
   */
  execute(
    id: string,
    rawInput: unknown
  ): { taskIds: string[]; sessionResponse?: string } {
    const template = this.repo.getById(id);
    if (!template) {
      throw new TemplateNotFoundError(id);
    }
    if (!this.taskEngine) {
      throw new Error("TaskEngine not available for execution");
    }

    const input = ExecuteTemplateSchema.parse(rawInput);
    const vars = input.variables;

    // Resolve effective mode: explicit > template default > "task"
    const effectiveMode: OrchestrationMode = input.mode ?? template.defaultMode ?? "task";

    if (effectiveMode === "session") {
      return this.executeSessionMode(template, input, vars);
    }

    // Validate required variables
    for (const v of template.variables) {
      if (v.required && !vars[v.name] && !v.defaultValue) {
        throw new Error(`Missing required variable: ${v.name}`);
      }
      if (!vars[v.name] && v.defaultValue) {
        vars[v.name] = v.defaultValue;
      }
    }

    const taskIds: string[] = [];
    const stageTaskIds = new Map<string, string[]>();
    const engine = this.taskEngine;

    const submitStage = (stage: OrchestrationTemplate["stages"][number]): string[] => {
      const ids: string[] = [];
      for (const agent of stage.agents) {
        const goal = interpolateTemplate(agent.goal, vars);
        const task = engine.submit(
          {
            trigger: "agent",
            goal,
            context: JSON.stringify({ templateId: template.id, stage: stage.name }),
            model: agent.model ?? input.model,
            sessionId: input.sessionId,
            allowedTools: agent.allowedTools.length > 0 ? agent.allowedTools : undefined,
            autoApproveTools:
              agent.autoApproveTools.length > 0 ? agent.autoApproveTools : undefined,
            agentName: agent.archetype,
          },
          { mode: "background" }
        );
        ids.push(task.id);
        taskIds.push(task.id);
      }
      stageTaskIds.set(stage.name, ids);
      return ids;
    };

    // Separate stages into immediately-ready vs. dependent
    const readyStages = template.stages.filter((s) => s.dependsOn.length === 0);
    const pendingStages = template.stages.filter((s) => s.dependsOn.length > 0);

    // Submit stages that have no dependencies
    for (const stage of readyStages) {
      submitStage(stage);
    }

    // Wire up event-driven chaining for stages with dependencies
    if (pendingStages.length > 0) {
      const completedStages = new Set<string>();

      const trySubmitPending = (): void => {
        let submitted = false;
        for (const stage of pendingStages) {
          if (stageTaskIds.has(stage.name)) continue;
          if (stage.dependsOn.every((dep) => completedStages.has(dep))) {
            submitStage(stage);
            submitted = true;
          }
        }
        // If we submitted new stages, check again (cascading deps)
        if (submitted) trySubmitPending();
      };

      const isStageComplete = (stageName: string): boolean => {
        const ids = stageTaskIds.get(stageName);
        if (!ids) return false;
        return ids.every((tid) => {
          const t = engine.getTask(tid);
          return t && (t.status === "completed" || t.status === "failed" || t.status === "cancelled");
        });
      };

      const onTaskDone = (): void => {
        for (const [stageName] of stageTaskIds) {
          if (completedStages.has(stageName)) continue;
          if (isStageComplete(stageName)) {
            completedStages.add(stageName);
          }
        }
        trySubmitPending();

        // Clean up listeners once all pending stages have been submitted
        if (pendingStages.every((s) => stageTaskIds.has(s.name))) {
          engine.removeListener("task:completed", onTaskDone);
          engine.removeListener("task:failed", onTaskDone);
          engine.removeListener("task:cancelled", onTaskDone);
        }
      };

      engine.on("task:completed", onTaskDone);
      engine.on("task:failed", onTaskDone);
      engine.on("task:cancelled", onTaskDone);
    }

    return { taskIds };
  }

  /**
   * Session mode: compose all agent goals into a single prompt and execute
   * via copilot.chat() with enableSubagents: true.
   */
  private executeSessionMode(
    template: OrchestrationTemplate,
    input: { variables: Record<string, string>; sessionId?: string; model?: string },
    vars: Record<string, string>,
  ): { taskIds: string[]; sessionResponse?: string } {
    if (!this.copilot) {
      throw new Error("CopilotWrapper not available for session mode execution");
    }

    // Validate required variables
    for (const v of template.variables) {
      if (v.required && !vars[v.name] && !v.defaultValue) {
        throw new Error(`Missing required variable: ${v.name}`);
      }
      if (!vars[v.name] && v.defaultValue) {
        vars[v.name] = v.defaultValue;
      }
    }

    const engine = this.taskEngine!;
    const copilot = this.copilot;

    // Compose a single prompt from all stages/agents
    const allAgents = template.stages.flatMap((s) => s.agents);
    const taskSections = allAgents.map((agent, i) => {
      const goal = interpolateTemplate(agent.goal, vars);
      return `## Task ${i + 1}: ${goal}`;
    });

    const composedPrompt = [
      "You are an orchestrator coordinating multiple analysis tasks.",
      "Complete each task sequentially, using the most appropriate specialist approach for each.",
      "",
      ...taskSections,
      "",
      ...(template.aggregationPrompt
        ? [interpolateTemplate(template.aggregationPrompt, vars)]
        : []),
    ].join("\n");

    // Create a tracking task (submitted as immediate, completed asynchronously)
    const orchestrationGoal = `[session] Template "${template.name}": ${allAgents.length} agents`;
    const trackingTask = engine.submit(
      {
        trigger: "agent",
        goal: orchestrationGoal,
        context: JSON.stringify({ templateId: template.id, mode: "session" }),
        model: input.model,
        sessionId: input.sessionId,
      },
      { mode: "immediate" },
    );

    // Fire the session chat asynchronously (non-blocking)
    const customAgents = copilot.getCustomAgents();
    const chatAndComplete = async () => {
      try {
        let fullResponse = "";
        for await (const chunk of copilot.chat(composedPrompt, {
          enableSubagents: true,
          tools: [],
          ...(customAgents.length > 0 ? { customAgents } : {}),
          ...(input.model ? { model: input.model } : {}),
        })) {
          fullResponse += chunk;
        }
        engine.complete(trackingTask.id, fullResponse.slice(0, 500));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Template session mode execution failed", { templateId: template.id, error: msg });
        engine.fail(trackingTask.id, msg);
      }
    };
    chatAndComplete().catch(() => {});

    return { taskIds: [trackingTask.id] };
  }

  /** Seed built-in example templates if they don't already exist. */
  seedBuiltIns(): number {
    const existing = this.repo.count();
    if (existing > 0) return 0;

    const builtIns: CreateOrchestrationTemplateInput[] = [
      {
        name: "Research & Synthesize",
        description: "Multi-source research followed by synthesis into a coherent report.",
        category: "research",
        stages: [
          {
            name: "research",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Research {{topic}} from academic sources", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
              { archetype: "researcher", goal: "Research {{topic}} from industry sources", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
          {
            name: "synthesize",
            type: "sequential",
            agents: [
              { archetype: "writer", goal: "Synthesize research findings on {{topic}} into a comprehensive report", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: ["research"],
          },
        ],
        variables: [
          { name: "topic", description: "The topic to research", required: true, defaultValue: null },
        ],
        aggregationPrompt: "Combine the research findings into a well-structured report.",
      },
      {
        name: "Multi-Perspective Analysis",
        description: "Analyze a topic from multiple perspectives, then compare and contrast.",
        category: "analysis",
        stages: [
          {
            name: "perspectives",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Analyze {{subject}} from a technical perspective", model: null, allowedTools: [], autoApproveTools: [] },
              { archetype: "researcher", goal: "Analyze {{subject}} from a business perspective", model: null, allowedTools: [], autoApproveTools: [] },
              { archetype: "researcher", goal: "Analyze {{subject}} from a user experience perspective", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
        ],
        variables: [
          { name: "subject", description: "The subject to analyze", required: true, defaultValue: null },
        ],
        aggregationPrompt: "Compare and contrast the different perspectives on {{subject}}.",
      },
      {
        name: "Code Review Pipeline",
        description: "Automated code review: security audit, performance check, and style review.",
        category: "dev",
        stages: [
          {
            name: "review",
            type: "parallel",
            agents: [
              { archetype: "coder", goal: "Security audit of {{codebase}}: check for OWASP Top 10 vulnerabilities", model: null, allowedTools: ["read-file", "list-directory"], autoApproveTools: [] },
              { archetype: "coder", goal: "Performance review of {{codebase}}: identify bottlenecks and optimization opportunities", model: null, allowedTools: ["read-file", "list-directory"], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
        ],
        variables: [
          { name: "codebase", description: "Path or description of code to review", required: true, defaultValue: null },
        ],
        aggregationPrompt: null,
      },
      {
        name: "Content Creation",
        description: "Research, outline, write, and polish content on a given topic.",
        category: "content",
        stages: [
          {
            name: "research",
            type: "sequential",
            agents: [
              { archetype: "researcher", goal: "Research {{topic}} for a {{format}} article", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
          {
            name: "write",
            type: "sequential",
            agents: [
              { archetype: "writer", goal: "Write a {{format}} article about {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: ["research"],
          },
        ],
        variables: [
          { name: "topic", description: "Content topic", required: true, defaultValue: null },
          { name: "format", description: "Content format (blog post, report, etc.)", required: false, defaultValue: "blog post" },
        ],
        aggregationPrompt: null,
      },
      {
        name: "Competitive Analysis",
        description: "Research competitors in parallel, then synthesize findings.",
        category: "analysis",
        stages: [
          {
            name: "research",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Research {{competitor1}} as a competitor to {{company}}", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
              { archetype: "researcher", goal: "Research {{competitor2}} as a competitor to {{company}}", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
        ],
        variables: [
          { name: "company", description: "Your company name", required: true, defaultValue: null },
          { name: "competitor1", description: "First competitor", required: true, defaultValue: null },
          { name: "competitor2", description: "Second competitor", required: true, defaultValue: null },
        ],
        aggregationPrompt: "Create a competitive analysis comparing {{competitor1}} and {{competitor2}} as competitors to {{company}}.",
      },
    ];

    let seeded = 0;
    for (const template of builtIns) {
      if (!this.repo.getByName(template.name)) {
        try {
          this.repo.insert(template, true);
          seeded++;
        } catch (err) {
          logger.warn(`Failed to seed built-in template "${template.name}"`, { error: err });
        }
      }
    }
    return seeded;
  }
}
