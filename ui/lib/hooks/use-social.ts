/**
 * React Query hooks for the Social Brain subsystem.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";

// ── Types ──

export type SocialStats = {
  totalContacts: number;
  activeHandoffs: number;
  totalMessages: number;
  messagesLast24h: number;
  totalAutomationTriggers: number;
  connections: { platform: string; connected: boolean; configured?: boolean; enabled?: boolean; mode?: string }[];
};

export type PollHealth = {
  consecutiveErrors: number;
  lastSuccess: string | null;
  lastError: string | null;
  backoffUntil: string | null;
  totalPolls: number;
};

export type PlatformConfigEntry = {
  platform: string;
  connected: boolean;
  configured: boolean;
  enabled: boolean;
  mode: string;
  envVar: string;
  webhookPath: string;
  docsUrl: string;
  adapterRegistered?: boolean;
  activelyPolling?: boolean;
  pollHealth?: PollHealth | null;
};

export type SocialConfig = {
  enabled: boolean;
  confidenceThreshold: string;
  webhookVerifyToken: boolean;
  platforms: PlatformConfigEntry[];
};

export type Contact = {
  id: string;
  platform: string;
  platform_user_id: string;
  username: string;
  display_name: string;
  tags: string;
  notes: string;
  first_seen_at: string;
  last_seen_at: string;
  message_count: number;
  handoff_active: number;
  handoff_thread_id: string | null;
  handoff_channel: string | null;
  created_at: string;
  updated_at: string;
};

export type PaginatedContacts = {
  data: Contact[];
  total: number;
  page: number;
  pageSize: number;
};

export type SocialMessage = {
  id: string;
  contact_id: string;
  platform: string;
  direction: "inbound" | "outbound";
  status: string;
  platform_message_id: string;
  content: string;
  metadata: string;
  created_at: string;
};

export type CommentRule = {
  id: string;
  name: string;
  platform: string;
  enabled: number;
  post_ids: string | null;
  keywords: string;
  regex: string | null;
  comment_reply_template: string | null;
  dm_template: string;
  dm_delay_seconds: number;
  max_triggers_per_user: number;
  max_triggers_total: number | null;
  trigger_count: number;
  auto_tag: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
};

export type AutomationLogEntry = {
  id: string;
  rule_id: string;
  contact_id: string | null;
  platform: string;
  post_id: string | null;
  comment_id: string;
  username: string;
  matched_keyword: string | null;
  comment_replied: number;
  dm_sent: number;
  dm_error: string | null;
  created_at: string;
};

// ── Hooks ──

export const useSocialStats = () =>
  useQuery({
    queryKey: ["social", "stats"],
    queryFn: () => fetchJson<SocialStats>("/api/social/stats"),
    refetchInterval: 10_000,
  });

export const useSocialContacts = (filters: {
  page?: number;
  pageSize?: number;
  platform?: string;
  search?: string;
  tag?: string;
  handoffActive?: boolean;
}) => {
  const params = new URLSearchParams();
  if (filters.page) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.search) params.set("search", filters.search);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.handoffActive !== undefined) params.set("handoffActive", String(filters.handoffActive));
  const qs = params.toString();

  return useQuery({
    queryKey: ["social", "contacts", filters],
    queryFn: () => fetchJson<PaginatedContacts>(`/api/social/contacts${qs ? `?${qs}` : ""}`),
    refetchInterval: 15_000,
  });
};

export const useSocialContact = (id: string) =>
  useQuery({
    queryKey: ["social", "contact", id],
    queryFn: () => fetchJson<Contact>(`/api/social/contacts/${id}`),
    enabled: !!id,
  });

export const useContactMessages = (contactId: string, limit = 50) =>
  useQuery({
    queryKey: ["social", "messages", contactId, limit],
    queryFn: () => fetchJson<{ messages: SocialMessage[] }>(`/api/social/contacts/${contactId}/messages?limit=${limit}`),
    enabled: !!contactId,
  });

export const useSocialActivity = (limit = 50) =>
  useQuery({
    queryKey: ["social", "activity", limit],
    queryFn: () => fetchJson<{ messages: SocialMessage[] }>(`/api/social/activity?limit=${limit}`),
    refetchInterval: 10_000,
  });

export const useSocialRules = (platform?: string) => {
  const qs = platform ? `?platform=${platform}` : "";
  return useQuery({
    queryKey: ["social", "rules", platform],
    queryFn: () => fetchJson<{ rules: CommentRule[] }>(`/api/social/rules${qs}`),
    refetchInterval: 15_000,
  });
};

export const useAutomationLog = (ruleId?: string, limit = 50) => {
  const params = new URLSearchParams();
  if (ruleId) params.set("ruleId", ruleId);
  params.set("limit", String(limit));
  return useQuery({
    queryKey: ["social", "automation-log", ruleId, limit],
    queryFn: () => fetchJson<{ log: AutomationLogEntry[] }>(`/api/social/rules/log?${params.toString()}`),
    refetchInterval: 15_000,
  });
};

export const useCreateRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rule: Partial<CommentRule>) =>
      fetchJson<CommentRule>("/api/social/rules", {
        method: "POST",
        body: JSON.stringify(rule),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social", "rules"] }),
  });
};

export const useUpdateRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string } & Partial<CommentRule>) =>
      fetchJson<CommentRule>(`/api/social/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social", "rules"] }),
  });
};

export const useDeleteRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ success: boolean }>(`/api/social/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social", "rules"] }),
  });
};

export const useAddTag = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, tag }: { contactId: string; tag: string }) =>
      fetchJson<Contact>(`/api/social/contacts/${contactId}/tags`, {
        method: "POST",
        body: JSON.stringify({ tag }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social"] }),
  });
};

export const useUpdateContact = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string; notes?: string; tags?: string }) =>
      fetchJson<Contact>(`/api/social/contacts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social"] }),
  });
};

export const useCloseHandoff = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, resolution }: { contactId: string; resolution?: string }) =>
      fetchJson<{ success: boolean }>(`/api/social/handoff/${contactId}/close`, {
        method: "POST",
        body: JSON.stringify({ resolution }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social"] }),
  });
};

export const useSocialConnections = () =>
  useQuery({
    queryKey: ["social", "connections"],
    queryFn: () => fetchJson<{ connections: { platform: string; connected: boolean; configured?: boolean; enabled?: boolean; mode?: string }[] }>("/api/social/connections"),
    refetchInterval: 30_000,
  });

export const useSocialConfig = () =>
  useQuery({
    queryKey: ["social", "config"],
    queryFn: () => fetchJson<SocialConfig>("/api/social/config"),
    refetchInterval: 30_000,
  });

export type WebhookLogEntry = { ts: string; platform: string; parsed: boolean; type?: string; source?: string };

export const useSocialWebhookLog = () =>
  useQuery({
    queryKey: ["social", "webhook-log"],
    queryFn: () => fetchJson<{ events: WebhookLogEntry[] }>("/api/social/webhook-log"),
    refetchInterval: 10_000,
  });

export const useTogglePlatform = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      fetchJson<{ ok: boolean }>(`/api/social/connections/${platform}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social", "config"] });
      qc.invalidateQueries({ queryKey: ["social", "stats"] });
      qc.invalidateQueries({ queryKey: ["social", "connections"] });
    },
  });
};

// ── AI Generate Rule ──

export type GeneratedRule = {
  name: string;
  platform: string;
  keywords: string;
  dm_template: string;
  comment_reply_template: string | null;
  dm_delay_seconds: number;
  max_triggers_per_user: number;
  auto_tag: string | null;
  use_ai_reply: number;
  ai_reply_context: string | null;
};

export const useGenerateRule = () =>
  useMutation({
    mutationFn: (params: { description: string; platform?: string; model?: string }) =>
      fetchJson<{ rule: GeneratedRule }>("/api/social/rules/generate", {
        method: "POST",
        body: JSON.stringify(params),
      }),
  });

// ── Follow-Up Steps ──

export type FollowUpStep = {
  id: string;
  rule_id: string;
  step_order: number;
  delay_seconds: number;
  message_template: string;
  created_at: string;
};

export const useFollowUps = (ruleId: string) =>
  useQuery({
    queryKey: ["social", "follow-ups", ruleId],
    queryFn: () => fetchJson<{ steps: FollowUpStep[] }>(`/api/social/rules/${ruleId}/follow-ups`),
    enabled: !!ruleId,
  });

export const useCreateFollowUp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, ...data }: { ruleId: string; stepOrder: number; delaySeconds: number; messageTemplate: string }) =>
      fetchJson<FollowUpStep>(`/api/social/rules/${ruleId}/follow-ups`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social", "follow-ups"] }),
  });
};

export const useDeleteFollowUp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, stepId }: { ruleId: string; stepId: string }) =>
      fetchJson<{ success: boolean }>(`/api/social/rules/${ruleId}/follow-ups/${stepId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["social", "follow-ups"] }),
  });
};

// ── Analytics & Leads ──

export type AnalyticsEntry = {
  platform: string;
  total_conversations: number;
  total_messages_in: number;
  total_messages_out: number;
  avg_response_time_ms: number;
  auto_reply_rate: number;
  escalation_rate: number;
  leads_captured: number;
};

export type LeadEntry = {
  id: string;
  platform: string;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  lead_captured_at: string;
  tags: string;
};

export const useSocialAnalytics = (since?: string) => {
  const qs = since ? `?since=${since}` : "";
  return useQuery({
    queryKey: ["social", "analytics", since],
    queryFn: () => fetchJson<{ analytics: AnalyticsEntry[] }>(`/api/social/analytics${qs}`),
    refetchInterval: 30_000,
  });
};

export const useSocialLeads = (platform?: string, limit = 50) => {
  const params = new URLSearchParams();
  if (platform) params.set("platform", platform);
  params.set("limit", String(limit));
  return useQuery({
    queryKey: ["social", "leads", platform, limit],
    queryFn: () => fetchJson<{ leads: LeadEntry[] }>(`/api/social/leads?${params.toString()}`),
    refetchInterval: 30_000,
  });
};

// ── Approval Queue ──

export type PendingApproval = SocialMessage & {
  contact_username?: string;
  contact_display_name?: string;
};

export const usePendingApprovals = () =>
  useQuery({
    queryKey: ["social", "approvals"],
    queryFn: () => fetchJson<{ data: PendingApproval[]; count: number }>("/api/social/approvals"),
    refetchInterval: 10_000,
  });

export const usePendingApprovalCount = () =>
  useQuery({
    queryKey: ["social", "approvals", "count"],
    queryFn: () => fetchJson<{ count: number }>("/api/social/approvals/count"),
    refetchInterval: 10_000,
  });

export const useApproveReply = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: boolean }>(`/api/social/approvals/${id}/approve`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social", "approvals"] });
      qc.invalidateQueries({ queryKey: ["social", "activity"] });
    },
  });
};

export const useRejectReply = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: boolean }>(`/api/social/approvals/${id}/reject`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social", "approvals"] });
      qc.invalidateQueries({ queryKey: ["social", "activity"] });
    },
  });
};

export const useEditAndApproveReply = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      fetchJson<{ ok: boolean }>(`/api/social/approvals/${id}/edit`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social", "approvals"] });
      qc.invalidateQueries({ queryKey: ["social", "activity"] });
    },
  });
};

// ── Manual Reply ──

export const useSendReply = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, content }: { contactId: string; content: string }) =>
      fetchJson<{ ok: boolean }>(`/api/social/contacts/${contactId}/reply`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social", "messages"] });
      qc.invalidateQueries({ queryKey: ["social", "activity"] });
    },
  });
};
