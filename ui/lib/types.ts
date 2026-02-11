/* ── Shared types for the OpenZigs UI ── */

export type ToolInfo = {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  enabled: boolean;
  source?: string;
};

export type Approval = {
  id: string;
  tool: string;
  riskLevel: string;
  status: string;
  createdAt: string;
  explanation: string;
  preview?: string;
  decidedVia?: string;
  args?: Record<string, unknown>;
};

export type AuditEntry = {
  id: string;
  timestamp: string;
  level: string;
  category: string;
  event: string;
  details: Record<string, unknown>;
};

export type SavedPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type ScheduledJob = {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  model?: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
};

export type EnvEntry = {
  name: string;
  label?: string;
  configured: boolean;
};

export type SidecarEnvVar = {
  name: string;
  configured: boolean;
};

export type SidecarCredential = {
  platform: string;
  label: string;
  imageAvailable: boolean;
  enabled: boolean;
  envVars: SidecarEnvVar[];
};

export type SidecarStatus = {
  name: string;
  running: boolean;
  healthy: boolean;
  url?: string;
  error?: string;
};

export type SidecarsResponse = {
  dockerAvailable: boolean;
  credentials: SidecarCredential[];
  sidecars: SidecarStatus[];
};

export type ChannelConfig = {
  telegram: {
    enabled: boolean;
    model?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    adminUserId?: string;
    allowedUsers?: string[];
  };
  discord: {
    enabled: boolean;
    allowedGuilds?: string[];
  };
};

export type ModelInfo = {
  id: string;
};

export type LocalServerDefinition = {
  name: string;
  label: string;
  runtime: string;
  command: string;
  args: string[];
  category: string;
  requiresCredentials: boolean;
  requiredEnvVars?: string[];
};

export type LocalServerStatus = {
  name: string;
  running: boolean;
  toolCount: number;
  error?: string;
};

export type LocalServerCredential = {
  server: string;
  envVars: SidecarEnvVar[];
};

export type LocalServersResponse = {
  servers: LocalServerStatus[];
  credentials: LocalServerCredential[];
  definitions: LocalServerDefinition[];
};

export type PersonalityConfig = {
  systemInstruction: string;
  prePrompt: string;
  postPrompt: string;
  enabled: boolean;
  updatedAt: string;
};

export type SessionInfo = {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  channel: string;
  userId: string;
  metadata: Record<string, unknown>;
};

export type ConversationEvent = {
  timestamp: string;
  type: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    duration?: number;
  };
};
