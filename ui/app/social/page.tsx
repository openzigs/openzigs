"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineModelPicker } from "@/components/model-picker-select";
import {
  useSocialStats,
  useSocialContacts,
  useContactMessages,
  useSocialActivity,
  useSocialRules,
  useAutomationLog,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  useAddTag,
  useUpdateContact,
  useCloseHandoff,
  useSocialConfig,
  useSocialWebhookLog,
  useTogglePlatform,
  useGenerateRule,
  useFollowUps,
  useCreateFollowUp,
  useDeleteFollowUp,
  useSocialAnalytics,
  useSocialLeads,
  usePendingApprovals,
  useApproveReply,
  useRejectReply,
  useEditAndApproveReply,
  useSendReply,
  type Contact,
  type CommentRule,
  type PlatformConfigEntry,
  type FollowUpStep,
  type AnalyticsEntry,
  type LeadEntry,
} from "@/lib/hooks/use-social";

type Tab = "dashboard" | "crm" | "automations" | "activity" | "settings" | "leads" | "analytics";

export default function SocialBrainPage() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [askAiOpen, setAskAiOpen] = useState(false);

  return (
    <main className="mx-auto max-w-6xl px-6 pb-12 pt-4">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Social Brain</h1>
          <p className="text-sm text-muted-foreground">
            Unified inbox, CRM, and automated response engine for social platforms.
          </p>
        </div>
        <AskAiButton onClick={() => setAskAiOpen(true)} />
      </div>

      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 rounded-lg bg-muted p-1">
        {(["dashboard", "crm", "automations", "leads", "analytics", "activity", "settings"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition ${
              activeTab === tab
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "dashboard" && <DashboardTab />}
      {activeTab === "crm" && <CrmTab />}
      {activeTab === "automations" && <AutomationsTab />}
      {activeTab === "leads" && <LeadsTab />}
      {activeTab === "analytics" && <AnalyticsTab />}
      {activeTab === "activity" && <ActivityTab />}
      {activeTab === "settings" && <SettingsTab />}

      <ToastContainer />
      <AskAiPanel pageContext={PAGE_CONTEXTS["social"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </main>
  );
}

// ── Dashboard Tab ──────────────────────────────────────────────────────

function DashboardTab() {
  const { data: stats } = useSocialStats();

  if (!stats) {
    return <p className="text-sm text-muted-foreground">Loading stats...</p>;
  }

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard label="Contacts" value={stats.totalContacts} />
        <StatCard label="Active Handoffs" value={stats.activeHandoffs} accent={stats.activeHandoffs > 0} />
        <StatCard label="Total Messages" value={stats.totalMessages} />
        <StatCard label="Messages (24h)" value={stats.messagesLast24h} />
        <StatCard label="Automation Triggers" value={stats.totalAutomationTriggers} />
      </div>

      {/* Connected platforms */}
      <SectionCard title="Connected Platforms" defaultOpen>
        {stats.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No platforms connected yet. Go to the Settings tab to configure platforms.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {stats.connections.filter((c) => c.connected || c.configured).map((c) => (
              <span
                key={c.platform}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  c.connected
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                }`}
              >
                {c.platform} {c.connected ? "" : "(token set, not enabled)"}
              </span>
            ))}
            {stats.connections.filter((c) => c.connected || c.configured).length === 0 && (
              <p className="text-sm text-muted-foreground">No platforms configured. Go to the Settings tab to get started.</p>
            )}
          </div>
        )}
      </SectionCard>

      {/* Pinterest Analytics link */}
      <Link
        href="/social/pinterest"
        className="flex items-center justify-between rounded-xl border border-border bg-card p-4 transition hover:border-primary/30 hover:shadow-sm"
      >
        <div>
          <p className="text-sm font-semibold">Pinterest Analytics</p>
          <p className="text-xs text-muted-foreground">View SEO reports, keyword metrics, trends, and pin analysis.</p>
        </div>
        <span className="text-xs text-muted-foreground">&rarr;</span>
      </Link>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${accent ? "text-orange-500" : ""}`}>{value}</p>
    </div>
  );
}

// ── CRM Tab ────────────────────────────────────────────────────────────

function CrmTab() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);

  const { data } = useSocialContacts({
    page,
    pageSize: 25,
    search: search || undefined,
    platform: platform || undefined,
  });

  const contacts = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 25);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search contacts..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm flex-1 min-w-[200px]"
        />
        <select
          value={platform}
          onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">All Platforms</option>
          {["twitter", "linkedin", "reddit", "youtube", "tiktok", "instagram", "facebook"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {/* Contact table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-2 text-left font-medium">Username</th>
              <th className="px-4 py-2 text-left font-medium">Platform</th>
              <th className="px-4 py-2 text-left font-medium">Messages</th>
              <th className="px-4 py-2 text-left font-medium">Tags</th>
              <th className="px-4 py-2 text-left font-medium">Last Seen</th>
              <th className="px-4 py-2 text-left font-medium">Handoff</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr
                key={c.id}
                onClick={() => setSelectedContact(c)}
                className="cursor-pointer border-b border-border hover:bg-accent/5 transition"
              >
                <td className="px-4 py-2 font-medium">
                  {c.display_name || `@${c.username}`}
                </td>
                <td className="px-4 py-2">
                  <PlatformBadge platform={c.platform} />
                </td>
                <td className="px-4 py-2">{c.message_count}</td>
                <td className="px-4 py-2">
                  <TagList tags={c.tags} />
                </td>
                <td className="px-4 py-2 text-muted-foreground">
                  {new Date(c.last_seen_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-2">
                  {c.handoff_active ? (
                    <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-600">Active</span>
                  ) : null}
                </td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No contacts found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{total} contacts total</p>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50"
            >
              Prev
            </button>
            <span className="px-2 py-1 text-xs">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Contact Detail Drawer */}
      {selectedContact && (
        <ContactDetail
          contact={selectedContact}
          onClose={() => setSelectedContact(null)}
        />
      )}
    </div>
  );
}

function ContactDetail({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const { data: messagesData } = useContactMessages(contact.id, 20);
  const addTag = useAddTag();
  const updateContact = useUpdateContact();
  const closeHandoff = useCloseHandoff();
  const sendReply = useSendReply();
  const [newTag, setNewTag] = useState("");
  const [notes, setNotes] = useState(contact.notes);
  const [replyText, setReplyText] = useState("");

  const messages = messagesData?.messages ?? [];

  const handleAddTag = () => {
    if (!newTag.trim()) return;
    addTag.mutate(
      { contactId: contact.id, tag: newTag.trim() },
      {
        onSuccess: () => { setNewTag(""); showToast("Tag added", "success"); },
        onError: (err) => showToast(`Failed: ${err.message}`, "error"),
      },
    );
  };

  const handleSaveNotes = () => {
    updateContact.mutate(
      { id: contact.id, notes },
      {
        onSuccess: () => showToast("Notes saved", "success"),
        onError: (err) => showToast(`Failed: ${err.message}`, "error"),
      },
    );
  };

  const handleCloseHandoff = () => {
    const resolution = prompt("Resolution note (optional):");
    closeHandoff.mutate(
      { contactId: contact.id, resolution: resolution ?? undefined },
      {
        onSuccess: () => showToast("Handoff closed", "success"),
        onError: (err) => showToast(`Failed: ${err.message}`, "error"),
      },
    );
  };

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border bg-card p-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-bold">{contact.display_name || `@${contact.username}`}</h3>
          <p className="text-sm text-muted-foreground">
            <PlatformBadge platform={contact.platform} /> &middot; {contact.message_count} messages &middot; First seen {new Date(contact.first_seen_at).toLocaleDateString()}
          </p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">✕ Close</button>
      </div>

      {/* Tags */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Tags</p>
        <div className="flex flex-wrap gap-1 mb-2">
          <TagList tags={contact.tags} />
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
            placeholder="Add tag..."
            className="rounded-md border border-border bg-background px-2 py-1 text-xs flex-1"
          />
          <button onClick={handleAddTag} className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground">Add</button>
        </div>
      </div>

      {/* Notes */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Notes</p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button onClick={handleSaveNotes} className="mt-1 rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground">Save Notes</button>
      </div>

      {/* Handoff */}
      {contact.handoff_active === 1 && (
        <div className="flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
          <span className="text-sm font-medium text-orange-600">Handoff Active</span>
          <span className="text-xs text-muted-foreground">via {contact.handoff_channel}</span>
          <button
            onClick={handleCloseHandoff}
            className="ml-auto rounded-md bg-orange-600 px-3 py-1 text-xs text-white"
          >
            Close Handoff
          </button>
        </div>
      )}

      {/* Messages */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Recent Messages</p>
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border bg-background p-3">
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground">No messages yet.</p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-lg p-2 text-sm ${
                m.direction === "inbound"
                  ? "bg-muted/50"
                  : "bg-primary/5 ml-8"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium">
                  {m.direction === "inbound" ? "User" : "Bot"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(m.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm">{m.content}</p>
            </div>
          ))}
        </div>

        {/* Reply compose */}
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && replyText.trim()) {
                sendReply.mutate(
                  { contactId: contact.id, content: replyText.trim() },
                  {
                    onSuccess: () => { setReplyText(""); showToast("Reply sent", "success"); },
                    onError: (err) => showToast(`Failed: ${err.message}`, "error"),
                  },
                );
              }
            }}
            placeholder="Type a reply..."
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={() => {
              if (!replyText.trim()) return;
              sendReply.mutate(
                { contactId: contact.id, content: replyText.trim() },
                {
                  onSuccess: () => { setReplyText(""); showToast("Reply sent", "success"); },
                  onError: (err) => showToast(`Failed: ${err.message}`, "error"),
                },
              );
            }}
            disabled={!replyText.trim() || sendReply.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {sendReply.isPending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AI Rule Generator ──────────────────────────────────────────────────

function AiRuleGenerator({
  onGenerated,
  generateRule,
}: {
  onGenerated: (rule: Partial<CommentRule>) => void;
  generateRule: ReturnType<typeof useGenerateRule>;
}) {
  const [description, setDescription] = useState("");
  const [platform, setPlatform] = useState("");
  const [model, setModel] = useState("");

  const handleGenerate = () => {
    if (!description.trim()) return;
    generateRule.mutate(
      { description, platform: platform || undefined, model: model || undefined },
      {
        onSuccess: (data) => {
          if (data.rule) onGenerated(data.rule as Partial<CommentRule>);
        },
        onError: (err) => showToast(`Generation failed: ${err.message}`, "error"),
      },
    );
  };

  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-1.5">
        <span>✨</span> AI Rule Generator
      </h3>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder="Describe the automation you want, e.g. 'When someone comments asking about pricing on my Instagram posts, DM them a link to our pricing page and reply publicly to check their DMs'"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground">Platform (optional)</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
            <option value="">Auto-detect</option>
            {["twitter", "instagram", "facebook", "linkedin", "youtube", "reddit", "tiktok"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground">LLM Model</label>
          <div className="mt-1">
            <InlineModelPicker value={model} onChange={setModel} className="w-full" />
          </div>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generateRule.isPending || !description.trim()}
          className="rounded-md bg-purple-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {generateRule.isPending ? "Generating..." : "Generate Rule"}
        </button>
      </div>
    </div>
  );
}

// ── Automations Tab ────────────────────────────────────────────────────

function AutomationsTab() {
  const { data } = useSocialRules();
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();
  const generateRule = useGenerateRule();
  const [showCreate, setShowCreate] = useState(false);
  const [showAiGenerate, setShowAiGenerate] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<CommentRule | null>(null);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  const rules = data?.rules ?? [];

  const handleToggle = (rule: CommentRule) => {
    updateRule.mutate(
      { id: rule.id, enabled: rule.enabled ? 0 : 1 },
      {
        onSuccess: () => showToast(`Rule ${rule.enabled ? "disabled" : "enabled"}`, "success"),
        onError: (err) => showToast(`Failed: ${err.message}`, "error"),
      },
    );
  };

  const handleDelete = (rule: CommentRule) => {
    setRuleToDelete(rule);
  };

  const confirmDelete = () => {
    if (!ruleToDelete) return;
    deleteRule.mutate(ruleToDelete.id, {
      onSuccess: () => showToast("Rule deleted", "success"),
      onError: (err) => showToast(`Failed: ${err.message}`, "error"),
    });
    setRuleToDelete(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Comment Automation Rules</h2>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowAiGenerate(!showAiGenerate); setShowCreate(false); }}
            className="rounded-md border border-primary/30 bg-primary/10 px-4 py-2 text-sm text-primary hover:bg-primary/20"
          >
            {showAiGenerate ? "Cancel" : "AI Generate"}
          </button>
          <button
            onClick={() => { setShowCreate(!showCreate); setShowAiGenerate(false); }}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            {showCreate ? "Cancel" : "+ New Rule"}
          </button>
        </div>
      </div>

      {showAiGenerate && (
        <AiRuleGenerator
          onGenerated={(rule) => {
            createRule.mutate(rule, {
              onSuccess: () => { setShowAiGenerate(false); showToast("AI-generated rule created", "success"); },
              onError: (err) => showToast(`Failed: ${err.message}`, "error"),
            });
          }}
          generateRule={generateRule}
        />
      )}

      {showCreate && (
        <RuleForm
          onSubmit={(data) => {
            createRule.mutate(data, {
              onSuccess: () => { setShowCreate(false); showToast("Rule created", "success"); },
              onError: (err) => showToast(`Failed: ${err.message}`, "error"),
            });
          }}
        />
      )}

      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No automation rules configured yet.</p>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1 cursor-pointer" onClick={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{rule.name}</h3>
                    <PlatformBadge platform={rule.platform} />
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      rule.enabled ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"
                    }`}>
                      {rule.enabled ? "Active" : "Disabled"}
                    </span>
                    {(rule as CommentRule & { use_ai_reply?: number }).use_ai_reply ? (
                      <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-xs text-purple-600">AI Reply</span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Keywords: {JSON.parse(rule.keywords).join(", ") || "none"} &middot;
                    Triggered {rule.trigger_count} times
                    {rule.max_triggers_total ? ` / ${rule.max_triggers_total} max` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    DM: &quot;{rule.dm_template.slice(0, 80)}{rule.dm_template.length > 80 ? "..." : ""}&quot;
                    {rule.dm_delay_seconds > 0 ? ` (${rule.dm_delay_seconds}s delay)` : ""}
                    {rule.model ? ` · Model: ${rule.model}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleToggle(rule)}
                    className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent/10"
                  >
                    {rule.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => handleDelete(rule)}
                    className="rounded-md border border-destructive/30 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {expandedRuleId === rule.id && <FollowUpStepsSection ruleId={rule.id} />}
            </div>
          ))}
        </div>
      )}

      {/* Automation Log */}
      <AutomationLogSection />

      {ruleToDelete && (
        <ConfirmDialog
          title="Delete Rule"
          message={`Are you sure you want to delete rule "${ruleToDelete.name}"?`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setRuleToDelete(null)}
        />
      )}
    </div>
  );
}

function RuleForm({ onSubmit }: { onSubmit: (data: Partial<CommentRule>) => void }) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("twitter");
  const [keywords, setKeywords] = useState("");
  const [dmTemplate, setDmTemplate] = useState("");
  const [commentReply, setCommentReply] = useState("");
  const [dmDelay, setDmDelay] = useState(0);
  const [maxPerUser, setMaxPerUser] = useState(1);
  const [autoTag, setAutoTag] = useState("");
  const [ruleModel, setRuleModel] = useState("");
  const [useAiReply, setUseAiReply] = useState(false);
  const [aiReplyContext, setAiReplyContext] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      platform,
      enabled: 1,
      keywords: JSON.stringify(keywords.split(",").map((k) => k.trim()).filter(Boolean)),
      dm_template: dmTemplate,
      comment_reply_template: commentReply || null,
      dm_delay_seconds: dmDelay,
      max_triggers_per_user: maxPerUser,
      auto_tag: autoTag || null,
      model: ruleModel || null,
      use_ai_reply: useAiReply ? 1 : 0,
      ai_reply_context: aiReplyContext || null,
    } as Partial<CommentRule>);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Rule Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
            {["twitter", "linkedin", "reddit", "youtube", "tiktok", "instagram", "facebook"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Keywords (comma-separated)</label>
        <input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)}
          placeholder="interested, pricing, demo"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">DM Template</label>
        <textarea value={dmTemplate} onChange={(e) => setDmTemplate(e.target.value)} required rows={2}
          placeholder="Hey {{username}}, thanks for your interest! ..."
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <p className="text-xs text-muted-foreground mt-0.5">Variables: {"{{username}}, {{keyword}}, {{post_id}}, {{post_caption}}, {{post_url}}"}</p>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Comment Reply Template (optional)</label>
        <input type="text" value={commentReply} onChange={(e) => setCommentReply(e.target.value)}
          placeholder="Thanks for commenting! Check your DMs 📬"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">DM Delay (seconds)</label>
          <input type="number" value={dmDelay} onChange={(e) => setDmDelay(Number(e.target.value))} min={0} max={3600}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Max per User</label>
          <input type="number" value={maxPerUser} onChange={(e) => setMaxPerUser(Number(e.target.value))} min={1} max={100}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Auto-Tag</label>
          <input type="text" value={autoTag} onChange={(e) => setAutoTag(e.target.value)}
            placeholder="lead"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
        </div>
      </div>
      {/* AI Reply toggle & context */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={useAiReply} onChange={(e) => setUseAiReply(e.target.checked)}
            className="h-4 w-4 rounded border-border" />
          <span className="text-xs font-medium text-muted-foreground">Use AI-Generated Replies</span>
          <span className="text-[10px] text-purple-500">(instead of static templates)</span>
        </label>
        {useAiReply && (
          <div>
            <label className="text-xs font-medium text-muted-foreground">AI Context / Instructions</label>
            <textarea value={aiReplyContext} onChange={(e) => setAiReplyContext(e.target.value)} rows={3}
              placeholder="Tell the AI about your brand, products, tone of voice, and what to say (up to 10K chars)..."
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <p className="text-[10px] text-muted-foreground mt-0.5">The AI will use this context to generate personalized replies to each comment</p>
          </div>
        )}
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">LLM Model Override</label>
        <div className="mt-1">
          <InlineModelPicker value={ruleModel} onChange={setRuleModel} className="w-full" />
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5">Leave as Default to use the system-wide model</p>
      </div>
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
        Create Rule
      </button>
    </form>
  );
}

function AutomationLogSection() {
  const { data } = useAutomationLog(undefined, 25);
  const log = data?.log ?? [];

  if (log.length === 0) return null;

  return (
    <SectionCard title="Automation Log" defaultOpen={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-1 text-left font-medium">Time</th>
              <th className="px-3 py-1 text-left font-medium">Username</th>
              <th className="px-3 py-1 text-left font-medium">Platform</th>
              <th className="px-3 py-1 text-left font-medium">Keyword</th>
              <th className="px-3 py-1 text-left font-medium">Reply</th>
              <th className="px-3 py-1 text-left font-medium">DM</th>
            </tr>
          </thead>
          <tbody>
            {log.map((entry) => (
              <tr key={entry.id} className="border-b border-border">
                <td className="px-3 py-1 text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</td>
                <td className="px-3 py-1">@{entry.username}</td>
                <td className="px-3 py-1"><PlatformBadge platform={entry.platform} /></td>
                <td className="px-3 py-1">{entry.matched_keyword ?? "—"}</td>
                <td className="px-3 py-1">{entry.comment_replied ? "✓" : "—"}</td>
                <td className="px-3 py-1">
                  {entry.dm_sent ? "✓" : entry.dm_error ? (
                    <span className="text-destructive" title={entry.dm_error}>✗</span>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── Activity Tab ───────────────────────────────────────────────────────

function ActivityTab() {
  const { data } = useSocialActivity(100);
  const { data: approvalsData } = usePendingApprovals();
  const approveReply = useApproveReply();
  const rejectReply = useRejectReply();
  const editAndApprove = useEditAndApproveReply();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const messages = data?.messages ?? [];
  const pending = approvalsData?.data ?? [];

  return (
    <div className="space-y-6">
      {/* Approval Queue */}
      {pending.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-2">
            Pending Approval <span className="ml-2 rounded-full bg-orange-500/10 px-2 py-0.5 text-xs text-orange-600">{pending.length}</span>
          </h2>
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <PlatformBadge platform={p.platform} />
                  <span className="text-sm font-medium">→ @{p.contact_username || "unknown"}</span>
                  <span className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString()}</span>
                </div>
                {editingId === p.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={3}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          editAndApprove.mutate({ id: p.id, content: editContent }, {
                            onSuccess: () => { setEditingId(null); showToast("Reply edited & approved", "success"); },
                            onError: (err) => showToast(`Error: ${err.message}`, "error"),
                          });
                        }}
                        className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground"
                      >
                        Save & Approve
                      </button>
                      <button onClick={() => setEditingId(null)} className="rounded-md border border-border px-3 py-1 text-xs">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm mb-3">{p.content}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => approveReply.mutate(p.id, {
                          onSuccess: () => showToast("Reply approved", "success"),
                          onError: (err) => showToast(`Error: ${err.message}`, "error"),
                        })}
                        className="rounded-md bg-green-600 px-3 py-1 text-xs text-white"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => { setEditingId(p.id); setEditContent(p.content); }}
                        className="rounded-md border border-border px-3 py-1 text-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => rejectReply.mutate(p.id, {
                          onSuccess: () => showToast("Reply rejected", "success"),
                          onError: (err) => showToast(`Error: ${err.message}`, "error"),
                        })}
                        className="rounded-md bg-red-600 px-3 py-1 text-xs text-white"
                      >
                        Reject
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <h2 className="text-lg font-semibold">Recent Activity</h2>

      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="space-y-2">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex items-start gap-3 rounded-lg border border-border p-3 ${
                m.direction === "outbound" ? "bg-primary/5" : ""
              }`}
            >
              <div className="mt-0.5">
                <PlatformBadge platform={m.platform} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${
                    m.direction === "inbound" ? "text-blue-600" : "text-green-600"
                  }`}>
                    {m.direction === "inbound" ? "← Inbound" : "→ Outbound"}
                  </span>
                  <span className={`text-xs rounded-full px-2 py-0.5 ${
                    m.status === "auto_replied" ? "bg-green-500/10 text-green-600" :
                    m.status === "escalated" ? "bg-orange-500/10 text-orange-600" :
                    m.status === "failed" ? "bg-red-500/10 text-red-600" :
                    m.status === "pending_approval" ? "bg-yellow-500/10 text-yellow-600" :
                    m.status === "rejected" ? "bg-red-500/10 text-red-500" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {m.status === "pending_approval" ? "pending approval" : m.status}
                  </span>
                </div>
                <p className="mt-1 text-sm truncate">{m.content}</p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(m.created_at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Settings Tab ───────────────────────────────────────────────────────

function SettingsTab() {
  const { data: config } = useSocialConfig();
  const voicesQuery = useQuery({
    queryKey: ["brand-voices"],
    queryFn: () => fetchJson<{ voices: Array<{ id: string; name: string; active: boolean }> }>("/api/admin/brand-voice"),
  });
  const voices = voicesQuery.data?.voices ?? [];
  const [savingVoice, setSavingVoice] = useState(false);

  // Fetch brain settings from admin endpoint
  const brainSettingsQuery = useQuery({
    queryKey: ["social", "brain-settings"],
    queryFn: () => fetchJson<{
      enabled: boolean;
      confidenceThreshold: string;
      commentAutomation: boolean;
      commentBrainEnabled: boolean;
      approvalRequired: boolean;
      notifications: { enabled: boolean; telegram: boolean; discord: boolean; web: boolean };
      handoff: Record<string, unknown>;
    }>("/api/admin/social-brain/settings"),
    refetchInterval: 30_000,
  });

  const saveBrainSettings = useMutation({
    mutationFn: (settings: Record<string, unknown>) =>
      fetchJson("/api/admin/social-brain/settings", {
        method: "POST",
        body: JSON.stringify(settings),
      }),
    onSuccess: () => {
      showToast("Settings saved", "success");
      brainSettingsQuery.refetch();
    },
    onError: (err) => showToast(`Error: ${(err as Error).message}`, "error"),
  });

  const voiceMutation = useMutation({
    mutationFn: (brandVoiceId: string | null) =>
      fetchJson("/api/social/brand-voice", {
        method: "PUT",
        body: JSON.stringify({ brandVoiceId }),
      }),
    onSuccess: () => showToast("Brand voice updated for Social Brain", "success"),
    onError: (err) => showToast(`Error: ${(err as Error).message}`, "error"),
    onSettled: () => setSavingVoice(false),
  });

  if (!config) {
    return <p className="text-sm text-muted-foreground">Loading configuration...</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Platform Configuration</h2>
        <p className="text-sm text-muted-foreground">
          Connect social platforms by setting environment variables and configuring webhooks on each platform&apos;s developer portal.
        </p>
      </div>

      {/* Global status */}
      <div className="flex flex-wrap gap-4">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Webhook Verify Token</p>
          <p className={`text-sm font-medium ${config.webhookVerifyToken ? "text-green-600" : "text-destructive"}`}>
            {config.webhookVerifyToken ? "Set" : "Not Set"}
          </p>
          {!config.webhookVerifyToken && (
            <p className="mt-1 text-xs text-muted-foreground">
              Set <code className="rounded bg-muted px-1">SOCIAL_WEBHOOK_VERIFY_TOKEN</code> in your .env
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Confidence Threshold</p>
          <p className="text-sm font-medium capitalize">{config.confidenceThreshold}</p>
        </div>
        {voices.length > 0 && (
          <div className="rounded-lg border border-border bg-card p-3 min-w-[200px]">
            <p className="text-xs text-muted-foreground mb-1">Brand Voice</p>
            <select
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground"
              defaultValue=""
              onChange={(e) => {
                setSavingVoice(true);
                voiceMutation.mutate(e.target.value || null);
              }}
              disabled={savingVoice}
            >
              <option value="">Default (active voice)</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.active ? " \u2713" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Platform cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {config.platforms.map((p) => (
          <PlatformCard key={p.platform} platform={p} />
        ))}
      </div>

      {/* AI Brain Settings */}
      <SectionCard title="AI Reply Settings" defaultOpen={true}>
        <div className="space-y-4">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={brainSettingsQuery.data?.commentBrainEnabled ?? false}
              onChange={(e) => saveBrainSettings.mutate({ commentBrainEnabled: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            <div>
              <p className="text-sm font-medium">AI Comment Replies</p>
              <p className="text-xs text-muted-foreground">Route comments (with no matching keyword rule) through the AI Brain for auto-reply</p>
            </div>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={brainSettingsQuery.data?.approvalRequired ?? false}
              onChange={(e) => saveBrainSettings.mutate({ approvalRequired: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            <div>
              <p className="text-sm font-medium">Require Approval</p>
              <p className="text-xs text-muted-foreground">Hold AI-generated replies for human review before sending (recommended)</p>
            </div>
          </label>
        </div>
      </SectionCard>

      {/* Notification Settings */}
      <SectionCard title="Notification Settings" defaultOpen={true}>
        <div className="space-y-4">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={brainSettingsQuery.data?.notifications?.enabled ?? false}
              onChange={(e) => saveBrainSettings.mutate({ notifications: { enabled: e.target.checked } })}
              className="h-4 w-4 rounded border-border"
            />
            <div>
              <p className="text-sm font-medium">Enable Push Notifications</p>
              <p className="text-xs text-muted-foreground">Push incoming message and comment alerts to configured channels</p>
            </div>
          </label>
          {brainSettingsQuery.data?.notifications?.enabled && (
            <div className="ml-7 space-y-3">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={brainSettingsQuery.data?.notifications?.telegram ?? true}
                  onChange={(e) => saveBrainSettings.mutate({ notifications: { telegram: e.target.checked } })}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="text-sm">Telegram</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={brainSettingsQuery.data?.notifications?.discord ?? true}
                  onChange={(e) => saveBrainSettings.mutate({ notifications: { discord: e.target.checked } })}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="text-sm">Discord</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={brainSettingsQuery.data?.notifications?.web ?? true}
                  onChange={(e) => saveBrainSettings.mutate({ notifications: { web: e.target.checked } })}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="text-sm">Web (Socket.IO — always available)</span>
              </label>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Webhook event log */}
      <WebhookEventLog />

      {/* Setup guide */}
      <SectionCard title="Quick Setup Guide" defaultOpen={false}>
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium">1. Set environment variables</p>
            <p className="text-muted-foreground">
              Add platform access tokens and <code className="rounded bg-muted px-1">SOCIAL_WEBHOOK_VERIFY_TOKEN</code> to your <code className="rounded bg-muted px-1">.env</code> file.
            </p>
          </div>
          <div>
            <p className="font-medium">2. Enable platforms</p>
            <p className="text-muted-foreground">
              Use the toggle switch on each platform card above to enable it. Polling platforms will start fetching data; webhook platforms will begin processing inbound events.
            </p>
          </div>
          <div>
            <p className="font-medium">3. Configure webhooks on the platform</p>
            <p className="text-muted-foreground">
              Set the webhook URL in the platform&apos;s developer portal. You need a public URL — use <code className="rounded bg-muted px-1">cloudflared</code> tunnel or ngrok for local dev.
            </p>
          </div>
          <div>
            <p className="font-medium">4. Restart the server</p>
            <p className="text-muted-foreground">
              Restart openzigs so the new credentials are loaded and the platform adapter is registered.
            </p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function PlatformCard({ platform: p }: { platform: PlatformConfigEntry }) {
  const toggle = useTogglePlatform();

  const isActive = p.enabled && p.connected;
  const needsToken = !p.configured;

  const statusColor = isActive
    ? "border-green-500/30 bg-green-500/5"
    : p.configured
      ? p.enabled
        ? "border-blue-500/30 bg-blue-500/5"
        : "border-border"
      : "border-border";

  const statusLabel = needsToken
    ? "Needs Setup"
    : isActive
      ? "Active"
      : p.enabled
        ? "Enabled"
        : "Disabled";

  const statusBadgeColor = needsToken
    ? "bg-muted text-muted-foreground"
    : isActive
      ? "bg-green-500/10 text-green-600"
      : p.enabled
        ? "bg-blue-500/10 text-blue-600"
        : "bg-muted text-muted-foreground";

  const modeLabel = p.mode === "polling"
    ? (p.pollHealth?.backoffUntil && new Date() < new Date(p.pollHealth.backoffUntil) ? "Backoff" : "Polling")
    : "Webhook";

  const isInBackoff = p.mode === "polling" && !!(p.pollHealth?.backoffUntil && new Date() < new Date(p.pollHealth.backoffUntil));
  const hasErrors = (p.pollHealth?.consecutiveErrors ?? 0) > 0;

  return (
    <div className={`rounded-lg border p-4 ${statusColor}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <PlatformBadge platform={p.platform} />
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeColor}`}>
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {p.mode === "polling" && p.activelyPolling && !isInBackoff && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
          )}
          {isInBackoff && (
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
            </span>
          )}
          <span className={`text-xs capitalize ${isInBackoff ? "text-yellow-600" : "text-muted-foreground"}`}>{modeLabel}</span>
          {hasErrors && (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
              {p.pollHealth!.consecutiveErrors} err
            </span>
          )}
          {/* Enable / Disable toggle */}
          <button
            type="button"
            onClick={() => {
              toggle.mutate(
                { platform: p.platform, enabled: !p.enabled },
                {
                  onSuccess: () => showToast(`${p.platform} ${!p.enabled ? "enabled" : "disabled"}`, "success"),
                  onError: (err) => showToast(`Error: ${(err as Error).message}`, "error"),
                },
              );
            }}
            disabled={toggle.isPending}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              p.enabled ? "bg-green-500" : "bg-muted-foreground/30"
            } ${toggle.isPending ? "opacity-50 cursor-not-allowed" : ""}`}
            role="switch"
            aria-checked={p.enabled}
            aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.platform}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ${
                p.enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Access Token</span>
          <span className={p.configured ? "text-green-600" : "text-destructive"}>
            {p.configured ? "Configured" : "Missing"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Adapter</span>
          <span className={p.adapterRegistered ? "text-green-600" : "text-muted-foreground"}>
            {p.adapterRegistered ? "Registered" : "Not Registered"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Env var: </span>
          <code className="rounded bg-muted px-1">{p.envVar}</code>
        </div>
        <div>
          <span className="text-muted-foreground">{p.mode === "polling" ? "Endpoint: " : "Webhook: "}</span>
          <code className="rounded bg-muted px-1 break-all">{p.webhookPath}</code>
        </div>
        {p.mode === "polling" && p.pollHealth && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last poll</span>
              <span className={p.pollHealth.lastSuccess ? "text-green-600" : "text-muted-foreground"}>
                {p.pollHealth.lastSuccess ? relativeTime(p.pollHealth.lastSuccess) : "Never"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total polls</span>
              <span className="tabular-nums">{p.pollHealth.totalPolls}</span>
            </div>
            {isInBackoff && p.pollHealth.lastError && (
              <div className="rounded bg-yellow-500/10 p-2 text-yellow-700">
                <p className="font-medium">Backoff active</p>
                <p className="truncate mt-0.5 text-yellow-600/80">{p.pollHealth.lastError}</p>
                <p className="mt-0.5">Retries at: {new Date(p.pollHealth.backoffUntil!).toLocaleTimeString()}</p>
              </div>
            )}
          </>
        )}
        {!p.configured && (
          <p className="text-xs text-destructive">
            Set the env var above in your .env file and restart the server.
          </p>
        )}
        <a
          href={p.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-primary hover:underline"
        >
          Platform docs &rarr;
        </a>
      </div>
    </div>
  );
}

// ── Shared Components ──────────────────────────────────────────────────

function WebhookEventLog() {
  const { data } = useSocialWebhookLog();
  const events = data?.events ?? [];

  const title = events.length > 0
    ? `Recent Inbound Events (${events.length})`
    : "Recent Inbound Events";

  return (
    <SectionCard title={title} defaultOpen>
      {events.length === 0 ? (
        <div className="rounded-md border border-dashed border-yellow-500/30 bg-yellow-500/5 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">No inbound events received yet</p>
          <p className="mt-1 text-muted-foreground">
            Events will appear here when platforms send webhooks to your server or when polling picks up new messages.
            If you&apos;ve configured webhooks on a platform&apos;s developer portal and still see nothing here, the webhook
            URL may not be reachable — verify your Cloudflare tunnel is running and the platform can reach your server.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Test with: <code className="rounded bg-muted px-1">curl -X POST https://&lt;your-domain&gt;/api/social/webhooks/instagram -H &quot;Content-Type: application/json&quot; -d &apos;{}&apos;</code>
          </p>
        </div>
      ) : (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {events.slice().reverse().map((ev, i) => (
            <div key={i} className="flex items-center gap-2 text-xs py-1 border-b border-border last:border-0">
              <span className="text-muted-foreground font-mono w-[160px] shrink-0">
                {new Date(ev.ts).toLocaleString()}
              </span>
              <PlatformBadge platform={ev.platform} />
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ev.source === "poll" ? "bg-blue-500/10 text-blue-600" : "bg-purple-500/10 text-purple-600"}`}>
                {ev.source === "poll" ? "poll" : "webhook"}
              </span>
              <span className={ev.parsed ? "text-green-600" : "text-destructive"}>
                {ev.parsed ? "Parsed" : "Failed"}
              </span>
              {ev.type && (
                <span className="text-muted-foreground">({ev.type})</span>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    twitter: "bg-sky-500/10 text-sky-600",
    linkedin: "bg-blue-700/10 text-blue-700",
    reddit: "bg-orange-500/10 text-orange-600",
    youtube: "bg-red-500/10 text-red-600",
    tiktok: "bg-fuchsia-500/10 text-fuchsia-600",
    instagram: "bg-pink-500/10 text-pink-600",
    facebook: "bg-blue-600/10 text-blue-600",
  };

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[platform] ?? "bg-muted text-muted-foreground"}`}>
      {platform}
    </span>
  );
}

function FollowUpStepsSection({ ruleId }: { ruleId: string }) {
  const { data, isLoading } = useFollowUps(ruleId);
  const createStep = useCreateFollowUp();
  const deleteStep = useDeleteFollowUp();
  const [showAdd, setShowAdd] = useState(false);
  const [delay, setDelay] = useState(3600);
  const [message, setMessage] = useState("");

  const steps: FollowUpStep[] = data?.steps ?? [];

  const handleAdd = () => {
    if (!message.trim()) return;
    createStep.mutate(
      { ruleId, stepOrder: steps.length + 1, delaySeconds: delay, messageTemplate: message },
      {
        onSuccess: () => { setMessage(""); setDelay(3600); setShowAdd(false); },
        onError: () => showToast("Failed to add follow-up step", "error"),
      },
    );
  };

  return (
    <div className="border-t border-border pt-3 mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-muted-foreground">Follow-Up Sequence</h4>
        <button onClick={() => setShowAdd(!showAdd)} className="text-xs text-primary hover:underline">
          {showAdd ? "Cancel" : "+ Add Step"}
        </button>
      </div>

      {isLoading && <p className="text-xs text-muted-foreground">Loading...</p>}

      {steps.length > 0 && (
        <div className="space-y-1">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-xs">
              <span className="font-mono text-muted-foreground">#{i + 1}</span>
              <span className="text-muted-foreground">after {Math.round(s.delay_seconds / 60)}m:</span>
              <span className="flex-1 truncate">{s.message_template}</span>
              <button
                onClick={() => deleteStep.mutate({ ruleId, stepId: s.id })}
                className="text-destructive hover:underline"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="flex items-end gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Delay (sec)</label>
            <input type="number" value={delay} onChange={(e) => setDelay(Number(e.target.value))} min={60}
              className="w-24 rounded-md border border-border bg-background px-2 py-1 text-xs" />
          </div>
          <div className="flex-1">
            <label className="text-[10px] text-muted-foreground">Message</label>
            <input type="text" value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="Just checking in..."
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs" />
          </div>
          <button onClick={handleAdd} disabled={createStep.isPending}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function LeadsTab() {
  const [platform, setPlatform] = useState<string>("");
  const { data, isLoading } = useSocialLeads(platform || undefined, 100);
  const leads: LeadEntry[] = data?.leads ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Captured Leads</h2>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm">
          <option value="">All Platforms</option>
          {["twitter", "linkedin", "instagram", "facebook", "youtube", "tiktok", "reddit"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading leads...</p>}

      {!isLoading && leads.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No leads captured yet. Create automation rules with keywords to start capturing leads from comments.</p>
        </div>
      )}

      {leads.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Platform</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Username</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Phone</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Tags</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Captured</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((lead) => (
                <tr key={lead.id} className="hover:bg-muted/20">
                  <td className="px-4 py-2"><PlatformBadge platform={lead.platform} /></td>
                  <td className="px-4 py-2 font-mono text-xs">@{lead.username}</td>
                  <td className="px-4 py-2">{lead.display_name || "—"}</td>
                  <td className="px-4 py-2 text-xs">{lead.email || "—"}</td>
                  <td className="px-4 py-2 text-xs">{lead.phone || "—"}</td>
                  <td className="px-4 py-2"><TagList tags={lead.tags} /></td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{relativeTime(lead.lead_captured_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AnalyticsTab() {
  const [since, setSince] = useState<string>("");
  const { data, isLoading } = useSocialAnalytics(since || undefined);
  const analytics: AnalyticsEntry[] = data?.analytics ?? [];

  const totals = analytics.reduce(
    (acc, e) => ({
      messages: acc.messages + e.total_messages_in + e.total_messages_out,
      inbound: acc.inbound + e.total_messages_in,
      outbound: acc.outbound + e.total_messages_out,
      contacts: acc.contacts + e.total_conversations,
    }),
    { messages: 0, inbound: 0, outbound: 0, contacts: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Conversation Analytics</h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Since</label>
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs" />
          {since && (
            <button onClick={() => setSince("")} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading analytics...</p>}

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold">{totals.messages}</p>
          <p className="text-xs text-muted-foreground">Total Messages</p>
        </div>
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold">{totals.inbound}</p>
          <p className="text-xs text-muted-foreground">Inbound</p>
        </div>
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold">{totals.outbound}</p>
          <p className="text-xs text-muted-foreground">Outbound</p>
        </div>
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold">{totals.contacts}</p>
          <p className="text-xs text-muted-foreground">Contacts</p>
        </div>
      </div>

      {/* Per-platform breakdown */}
      {analytics.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Platform</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Messages</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Inbound</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Outbound</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Contacts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {analytics.map((row) => (
                <tr key={row.platform} className="hover:bg-muted/20">
                  <td className="px-4 py-2"><PlatformBadge platform={row.platform} /></td>
                  <td className="px-4 py-2 text-right font-mono">{row.total_messages_in + row.total_messages_out}</td>
                  <td className="px-4 py-2 text-right font-mono">{row.total_messages_in}</td>
                  <td className="px-4 py-2 text-right font-mono">{row.total_messages_out}</td>
                  <td className="px-4 py-2 text-right font-mono">{row.total_conversations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && analytics.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No analytics data yet. Start conversations via automation rules or direct messages.</p>
        </div>
      )}
    </div>
  );
}

function TagList({ tags }: { tags: string }) {
  let parsed: string[] = [];
  try { parsed = JSON.parse(tags); } catch { /* empty */ }
  if (parsed.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {parsed.map((tag) => (
        <span key={tag} className="rounded-full bg-accent/20 px-2 py-0.5 text-xs">{tag}</span>
      ))}
    </div>
  );
}
