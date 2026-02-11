import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { Scheduler } from "../../productivity/scheduler.js";

const createJobSchema = z.object({
  name: z.string(),
  cronExpression: z.string(),
  timezone: z.string().optional(),
  actionType: z.enum(["prompt", "shell", "custom"]).optional(),
  actionPayload: z.record(z.unknown()),
  model: z.string().optional(),
  enabled: z.boolean().optional(),
  dry_run: z.boolean().optional(),
});

const listJobsSchema = z.object({});

const getJobSchema = z.object({
  id: z.string(),
});

const updateJobSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
  actionPayload: z.record(z.unknown()).optional(),
  model: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const deleteJobSchema = z.object({
  id: z.string(),
});

const toggleJobSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
});

const testJobSchema = z.object({
  id: z.string(),
});

export type SchedulerToolsOptions = {
  scheduler: Scheduler;
};

export const createSchedulerTools = ({ scheduler }: SchedulerToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "schedule-job",
      description: "Schedule a recurring job with a cron expression. Supports timezone-aware scheduling and model selection. Set dry_run to true to preview the job without persisting it — the action will be executed once and the result returned inline.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          cronExpression: { type: "string" },
          timezone: { type: "string" },
          actionType: { type: "string", enum: ["prompt", "shell", "custom"] },
          actionPayload: { type: "object" },
          model: { type: "string", description: "LLM model to use for this job (e.g. gpt-4.1, claude-sonnet-4)" },
          enabled: { type: "boolean" },
          dry_run: { type: "boolean", description: "If true, execute the action once without persisting the job or affecting the schedule" },
        },
        required: ["name", "cronExpression", "actionPayload"],
      },
      zodSchema: createJobSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as z.infer<typeof createJobSchema>;

        if (input.dry_run) {
          // Dry run: validate inputs but do NOT persist. Return a preview.
          const preview = {
            dryRun: true,
            name: input.name,
            cronExpression: input.cronExpression,
            timezone: input.timezone ?? "UTC",
            actionType: input.actionType ?? "prompt",
            actionPayload: input.actionPayload,
            model: input.model ?? null,
          };
          return {
            text: `[DRY RUN] Job preview — not persisted:\n${JSON.stringify(preview, null, 2)}`,
          };
        }

        try {
          const job = scheduler.create(input);
          return { text: JSON.stringify(job) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: message, isError: true };
        }
      },
    },
    {
      name: "list-jobs",
      description: "List all scheduled jobs",
      inputSchema: { type: "object", properties: {} },
      zodSchema: listJobsSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async () => {
        const jobs = scheduler.list();
        return { text: JSON.stringify(jobs) };
      },
    },
    {
      name: "get-job",
      description: "Get details of a specific scheduled job",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      zodSchema: getJobSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { id } = args as z.infer<typeof getJobSchema>;
        const job = scheduler.getById(id);
        if (!job) {
          return { text: `Job not found: ${id}`, isError: true };
        }
        return { text: JSON.stringify(job) };
      },
    },
    {
      name: "update-job",
      description: "Update an existing scheduled job",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          cronExpression: { type: "string" },
          timezone: { type: "string" },
          actionPayload: { type: "object" },
          model: { type: "string", description: "LLM model override (set to null to use default)" },
          enabled: { type: "boolean" },
        },
        required: ["id"],
      },
      zodSchema: updateJobSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const { id, ...rest } = args as z.infer<typeof updateJobSchema>;
        try {
          const updated = scheduler.update(id, rest);
          return { text: JSON.stringify(updated) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: message, isError: true };
        }
      },
    },
    {
      name: "delete-job",
      description: "Delete a scheduled job",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      zodSchema: deleteJobSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const { id } = args as z.infer<typeof deleteJobSchema>;
        const deleted = scheduler.delete(id);
        return { text: deleted ? "Job deleted" : "Job not found" };
      },
    },
    {
      name: "toggle-job",
      description: "Enable or disable a scheduled job",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["id", "enabled"],
      },
      zodSchema: toggleJobSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const { id, enabled } = args as z.infer<typeof toggleJobSchema>;
        try {
          const job = scheduler.setEnabled(id, enabled);
          return { text: JSON.stringify(job) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: message, isError: true };
        }
      },
    },
    {
      name: "test-job",
      description: "Execute an existing scheduled job once as a dry run without incrementing run counts or affecting scheduling state. Returns the job configuration for review.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ID of the scheduled job to test" },
        },
        required: ["id"],
      },
      zodSchema: testJobSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const { id } = args as z.infer<typeof testJobSchema>;
        const job = scheduler.getById(id);
        if (!job) {
          return { text: `Job not found: ${id}`, isError: true };
        }

        const preview = {
          dryRun: true,
          jobId: job.id,
          jobName: job.name,
          cronExpression: job.cronExpression,
          timezone: job.timezone,
          actionType: job.actionType,
          actionPayload: job.actionPayload,
          model: job.model,
          enabled: job.enabled,
          runCount: job.runCount,
          lastRunAt: job.lastRunAt,
        };

        return {
          text: `[DRY RUN] Test execution of job "${job.name}" — run count and schedule not affected:\n${JSON.stringify(preview, null, 2)}`,
        };
      },
    },
  ];
};
