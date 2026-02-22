/**
 * Social Brain MCP tools — CRM lookup, handoff management, message sending.
 *
 * Category: social | RiskLevel: low–medium depending on the tool.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { SocialRepository } from "../../channels/social/social-repository.js";
import type { HandoffManager } from "../../channels/social/handoff-manager.js";
import type { SocialPlatform } from "../../channels/social/types.js";

const lookupContactSchema = z.object({
  platform: z.enum(["instagram", "reddit", "youtube", "tiktok", "twitter", "facebook", "linkedin"]).optional()
    .describe("Filter contacts by platform"),
  username: z.string().optional().describe("Exact username to look up"),
  search: z.string().optional().describe("Search contacts by username, display name, or notes"),
  tag: z.string().optional().describe("Filter by tag"),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default: 10)"),
});

const getContactHistorySchema = z.object({
  contactId: z.string().describe("Contact ID to get message history for"),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum messages (default: 20)"),
});

const tagContactSchema = z.object({
  contactId: z.string().describe("Contact ID to tag"),
  tag: z.string().describe("Tag to add"),
});

const closeHandoffSchema = z.object({
  contactId: z.string().describe("Contact ID to close handoff for"),
  resolution: z.string().optional().describe("Resolution note"),
});

const socialStatsSchema = z.object({});

export type SocialBrainToolsOptions = {
  repository: SocialRepository;
  handoffManager: HandoffManager;
};

export const createSocialBrainTools = (options: SocialBrainToolsOptions): ToolDefinition[] => {
  const { repository, handoffManager } = options;

  const lookupContactTool: ToolDefinition = {
    name: "social-crm-lookup",
    description:
      "Look up contacts in the Social Brain CRM. Search by platform, username, tag, or free-text search. " +
      "Returns contact info including tags, message counts, and handoff status.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["instagram", "reddit", "youtube", "tiktok", "twitter", "facebook", "linkedin"] },
        username: { type: "string" },
        search: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number" },
      },
    },
    zodSchema: lookupContactSchema,
    category: "social",
    riskLevel: "low",
    handler: async (args) => {
      const input = args as z.infer<typeof lookupContactSchema>;

      // If exact username provided, try direct lookup across platforms
      if (input.username && !input.search) {
        const result = repository.listContacts({
          platform: input.platform as SocialPlatform | undefined,
          search: input.username,
          tag: input.tag,
          pageSize: input.limit ?? 10,
        });
        return { text: JSON.stringify(result.data, null, 2) };
      }

      const result = repository.listContacts({
        platform: input.platform as SocialPlatform | undefined,
        search: input.search,
        tag: input.tag,
        pageSize: input.limit ?? 10,
      });
      return { text: JSON.stringify(result.data, null, 2) };
    },
  };

  const getContactHistoryTool: ToolDefinition = {
    name: "social-crm-history",
    description:
      "Get message history for a specific Social Brain CRM contact. " +
      "Returns recent messages (inbound and outbound) in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["contactId"],
    },
    zodSchema: getContactHistorySchema,
    category: "social",
    riskLevel: "low",
    handler: async (args) => {
      const input = args as z.infer<typeof getContactHistorySchema>;
      const messages = repository.getMessages(input.contactId, input.limit ?? 20);
      return { text: JSON.stringify(messages, null, 2) };
    },
  };

  const tagContactTool: ToolDefinition = {
    name: "social-crm-tag",
    description: "Add a tag to a Social Brain CRM contact for organization and filtering.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        tag: { type: "string" },
      },
      required: ["contactId", "tag"],
    },
    zodSchema: tagContactSchema,
    category: "social",
    riskLevel: "low",
    handler: async (args) => {
      const input = args as z.infer<typeof tagContactSchema>;
      const updated = repository.addTag(input.contactId, input.tag);
      if (!updated) return { text: "Contact not found", isError: true };
      return { text: JSON.stringify(updated, null, 2) };
    },
  };

  const closeHandoffTool: ToolDefinition = {
    name: "social-close-handoff",
    description:
      "Close an active human handoff session for a Social Brain CRM contact. " +
      "Archives the support thread and marks the contact's handoff as resolved.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        resolution: { type: "string" },
      },
      required: ["contactId"],
    },
    zodSchema: closeHandoffSchema,
    category: "social",
    riskLevel: "medium",
    handler: async (args) => {
      const input = args as z.infer<typeof closeHandoffSchema>;
      const closed = await handoffManager.closeHandoff(input.contactId, input.resolution);
      if (!closed) return { text: "No active handoff for this contact", isError: true };
      return { text: "Handoff closed successfully" };
    },
  };

  const socialStatsTool: ToolDefinition = {
    name: "social-brain-stats",
    description:
      "Get Social Brain statistics: total contacts, active handoffs, message counts, and automation triggers.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    zodSchema: socialStatsSchema,
    category: "social",
    riskLevel: "low",
    handler: async () => {
      const stats = repository.getStats();
      return { text: JSON.stringify(stats, null, 2) };
    },
  };

  return [lookupContactTool, getContactHistoryTool, tagContactTool, closeHandoffTool, socialStatsTool];
};
