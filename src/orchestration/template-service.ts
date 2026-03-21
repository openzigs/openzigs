import type { TemplateRepository } from "./template-repository.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type {
  OrchestrationTemplate,
  CreateOrchestrationTemplateInput,
} from "./types.js";
import {
  CreateOrchestrationTemplateSchema,
  UpdateOrchestrationTemplateSchema,
  ExecuteTemplateSchema,
} from "./types.js";

const VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

/** Extract {{variable}} names from a string. */
export function extractVariables(text: string): string[] {
  const matches = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = VARIABLE_REGEX.exec(text)) !== null) {
    matches.add(m[1]);
  }
  return [...matches];
}

/** Replace {{variable}} placeholders with values. */
export function interpolateTemplate(
  text: string,
  variables: Record<string, string>
): string {
  return text.replace(VARIABLE_REGEX, (_, name: string) => {
    return variables[name] ?? `{{${name}}}`;
  });
}

export type TemplateServiceOptions = {
  repository: TemplateRepository;
  taskEngine?: TaskEngine;
};

export class TemplateService {
  private repo: TemplateRepository;
  private taskEngine?: TaskEngine;

  constructor(opts: TemplateServiceOptions) {
    this.repo = opts.repository;
    this.taskEngine = opts.taskEngine;
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
   * Returns the created task IDs.
   */
  execute(
    id: string,
    rawInput: unknown
  ): { taskIds: string[] } {
    const template = this.repo.getById(id);
    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }
    if (!this.taskEngine) {
      throw new Error("TaskEngine not available for execution");
    }

    const input = ExecuteTemplateSchema.parse(rawInput);
    const vars = input.variables;

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

    for (const stage of template.stages) {
      for (const agent of stage.agents) {
        const goal = interpolateTemplate(agent.goal, vars);

        const task = this.taskEngine.submit(
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

        taskIds.push(task.id);
      }
    }

    return { taskIds };
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
      try {
        this.repo.insert(template, true);
        seeded++;
      } catch {
        // Ignore duplicates from previous seeds
      }
    }
    return seeded;
  }
}
