"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bot, Loader2 } from "lucide-react";
import type { CustomAgentDefinition } from "@/lib/types";

interface AgentSelectorProps {
  sessionId: string | null;
  className?: string;
}

export function AgentSelector({ sessionId, className }: AgentSelectorProps) {
  const [agents, setAgents] = useState<CustomAgentDefinition[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>("__default__");
  const [switching, setSwitching] = useState(false);

  // Fetch available agents on mount
  useEffect(() => {
    let cancelled = false;
    fetchJson<{ agents: CustomAgentDefinition[] }>("/api/admin/agents")
      .then((data) => {
        if (!cancelled) setAgents(data.agents);
      })
      .catch(() => {
        // silently fail — agents list optional
      });
    return () => { cancelled = true; };
  }, []);

  // Fetch current agent for session when session changes
  useEffect(() => {
    if (!sessionId) {
      setActiveAgent("__default__");
      return;
    }
    let cancelled = false;
    fetchJson<{ agentName: string | null }>(`/api/admin/sessions/${encodeURIComponent(sessionId)}/agent`)
      .then((data) => {
        if (!cancelled) setActiveAgent(data.agentName ?? "__default__");
      })
      .catch(() => {
        // ignore
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const handleChange = useCallback(async (value: string) => {
    if (!sessionId) return;
    const agentName = value === "__default__" ? null : value;
    setSwitching(true);
    try {
      await fetchJson(`/api/admin/sessions/${encodeURIComponent(sessionId)}/agent`, {
        method: "POST",
        body: JSON.stringify({ agentName }),
      });
      setActiveAgent(value);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to switch agent", "error");
    } finally {
      setSwitching(false);
    }
  }, [sessionId]);

  if (agents.length === 0) return null;

  return (
    <div className={className} data-testid="agent-selector">
      <Select
        value={activeAgent}
        onValueChange={(v) => void handleChange(v)}
        disabled={!sessionId || switching}
      >
        <SelectTrigger className="h-8 w-40 text-xs" aria-label="Select agent">
          {switching ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : activeAgent !== "__default__" ? (
            <Bot className="mr-1 h-3 w-3 text-primary" />
          ) : null}
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__" className="text-xs">
            Default
          </SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.name} value={a.name} className="text-xs">
              <span className="font-medium">{a.displayName}</span>
              {a.description && (
                <span className="ml-1.5 text-muted-foreground">{a.description}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
