import * as z from "zod";
import type { ToolCategory, ToolDefinition, ToolRegistry, RiskLevel } from "./tool-registry.js";

export type ToolCatalogEntry = {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "read-file",
    description: "Read file contents from allowed directories",
    category: "filesystem",
    riskLevel: "low"
  },
  {
    name: "list-directory",
    description: "List directory entries from allowed directories",
    category: "filesystem",
    riskLevel: "low"
  },
  {
    name: "write-file",
    description: "Write content to a file",
    category: "filesystem",
    riskLevel: "high"
  },
  {
    name: "web-search",
    description: "Search the web using Brave Search API",
    category: "search",
    riskLevel: "low"
  },
  {
    name: "browser-read",
    description: "Read information from a Chrome tab via DevTools",
    category: "browser",
    riskLevel: "medium"
  },
  {
    name: "shell-execute",
    description: "Run a command in the terminal",
    category: "shell",
    riskLevel: "high"
  }
];

const buildStubTool = (entry: ToolCatalogEntry): ToolDefinition => {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: {
      type: "object",
      properties: {}
    },
    zodSchema: z.object({}),
    category: entry.category,
    riskLevel: entry.riskLevel,
    handler: async () => ({ text: "" })
  };
};

export const registerToolCatalog = (registry: ToolRegistry) => {
  for (const entry of TOOL_CATALOG) {
    registry.registerTool(buildStubTool(entry));
  }
};
