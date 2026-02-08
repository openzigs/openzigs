import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { Scheduler } from "../../productivity/scheduler.js";

const createJobSchema = z.object({
  name: z.string(),
  cronExpression: z.string(),
  timezone: z.string().optional(),
  actionType: z.enum(["prompt", "shell", "custom"]).optional(),
  actionPayload: z.record(z.unknown()),
  enabled: z.boolean().optional(),
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
  enabled: z.boolean().optional(),
});

const deleteJobSchema = z.object({
  id: z.string(),
});

const toggleJobSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
});

export type SchedulerToolsOptions = {
  scheduler: Scheduler;
};

export const createSchedulerTools = ({ scheduler }: SchedulerToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "schedule-job",
      description: "Schedule a recurring job with a cron expression. Supports timezone-aware scheduling.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          cronExpression: { type: "string" },
          timezone: { type: "string" },
          actionType: { type: "string", enum: ["prompt", "shell", "custom"] },
          actionPayload: { type: "object" },
          enabled: { type: "boolean" },
        },
        required: ["name", "cronExpression", "actionPayload"],
      },
      zodSchema: createJobSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as z.infer<typeof createJobSchema>;
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
  ];
};
