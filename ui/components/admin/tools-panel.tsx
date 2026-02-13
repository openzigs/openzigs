"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ToolInfo } from "@/lib/types";
import { Plug } from "lucide-react";

type ToolsPanelProps = {
  toolGroups: Record<string, ToolInfo[]>;
};

const CATEGORY_ORDER = [
  "filesystem", "search", "browser", "shell",
  "productivity", "social", "documents",
  "personal", "data", "developer",
];

const riskColors: Record<string, string> = {
  low: "bg-moss/15 text-moss dark:bg-moss/20 dark:text-green-400",
  medium: "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400",
  high: "bg-ember/15 text-ember dark:bg-ember/20 dark:text-red-400",
};

export const ToolsPanel = ({ toolGroups }: ToolsPanelProps) => {
  const queryClient = useQueryClient();
  const [togglingTool, setTogglingTool] = useState<string | null>(null);

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      fetchJson(`/api/admin/tools/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      setTogglingTool(null);
    },
    onError: () => setTogglingTool(null),
  });

  const globalApprovalMutation = useMutation({
    mutationFn: ({ name, required }: { name: string; required: boolean }) =>
      fetchJson(`/api/admin/tools/${encodeURIComponent(name)}/global-approval`, {
        method: "POST",
        body: JSON.stringify({ required }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const categories = [
    ...CATEGORY_ORDER.filter((category) => toolGroups[category]?.length),
    ...Object.keys(toolGroups)
      .filter((category) => !CATEGORY_ORDER.includes(category))
      .sort((a, b) => a.localeCompare(b)),
  ];

  return (
    <div className="space-y-4">
      {categories.map((category) => {
        const tools = toolGroups[category];
        if (!tools || tools.length === 0) return null;

        return (
          <div key={category}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {category.startsWith("user mcp:")
                ? `USER MCP: ${category.slice("user mcp:".length).trim().toUpperCase()}`
                : category}
            </p>
            <div className="space-y-1">
              {tools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 transition hover:border-ring/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[13px] font-semibold text-foreground">
                      {tool.source?.startsWith("mcp:") && <Plug className="mr-1 inline h-3.5 w-3.5 text-primary" />}
                      {tool.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{tool.description}</p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${riskColors[tool.riskLevel] ?? "bg-ink/5 text-ink/50"}`}
                  >
                    {tool.riskLevel}
                  </span>
                  <button
                    title={tool.globalApprovalRequired ? "Global approval lock ON — click to remove" : "Click to require approval for every call"}
                    className={`rounded-lg px-2 py-1 text-sm transition ${
                      tool.globalApprovalRequired
                        ? "bg-ember/15 text-ember dark:bg-ember/20 dark:text-red-400"
                        : "bg-muted/50 text-muted-foreground hover:bg-muted"
                    }`}
                    disabled={tool.source?.startsWith("mcp:")}
                    onClick={() => {
                      if (tool.source?.startsWith("mcp:")) return;
                      globalApprovalMutation.mutate({
                        name: tool.name,
                        required: !tool.globalApprovalRequired,
                      });
                    }}
                  >
                    {tool.globalApprovalRequired ? "🔒" : "🔓"}
                  </button>
                  <button
                    className={`w-16 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      tool.enabled ? "bg-moss text-white" : "bg-muted text-muted-foreground"
                    } disabled:opacity-40`}
                    disabled={togglingTool === tool.name || tool.name.endsWith("__disconnected__")}
                    onClick={() => {
                      if (tool.name.endsWith("__disconnected__")) return;
                      setTogglingTool(tool.name);
                      toggleMutation.mutate({ name: tool.name, enabled: !tool.enabled });
                    }}
                  >
                    {tool.enabled ? "On" : "Off"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
