"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
  type Contact,
  type CommentRule,
  type PlatformConfigEntry,
} from "@/lib/hooks/use-social";

type Tab = "dashboard" | "crm" | "automations" | "activity" | "settings";

export default function SocialBrainPage() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  return (
    <main className="mx-auto max-w-6xl px-6 pb-12 pt-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Social Brain</h1>
        <p className="text-sm text-muted-foreground">
          Unified inbox, CRM, and automated response engine for social platforms.
        </p>
      </div>

      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 rounded-lg bg-muted p-1">
        {(["dashboard", "crm", "automations", "activity", "settings"] as Tab[]).map((tab) => (
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
      {activeTab === "activity" && <ActivityTab />}
      {activeTab === "settings" && <SettingsTab />}

      <ToastContainer />
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
          {["instagram", "twitter", "facebook", "linkedin", "reddit", "youtube", "tiktok"].map((p) => (
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
  const [newTag, setNewTag] = useState("");
  const [notes, setNotes] = useState(contact.notes);

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
  const [showCreate, setShowCreate] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<CommentRule | null>(null);

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
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          {showCreate ? "Cancel" : "+ New Rule"}
        </button>
      </div>

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
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{rule.name}</h3>
                    <PlatformBadge platform={rule.platform} />
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      rule.enabled ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"
                    }`}>
                      {rule.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Keywords: {JSON.parse(rule.keywords).join(", ") || "none"} &middot;
                    Triggered {rule.trigger_count} times
                    {rule.max_triggers_total ? ` / ${rule.max_triggers_total} max` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    DM: &quot;{rule.dm_template.slice(0, 80)}{rule.dm_template.length > 80 ? "..." : ""}&quot;
                    {rule.dm_delay_seconds > 0 ? ` (${rule.dm_delay_seconds}s delay)` : ""}
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
  const [platform, setPlatform] = useState("instagram");
  const [keywords, setKeywords] = useState("");
  const [dmTemplate, setDmTemplate] = useState("");
  const [commentReply, setCommentReply] = useState("");
  const [dmDelay, setDmDelay] = useState(0);
  const [maxPerUser, setMaxPerUser] = useState(1);
  const [autoTag, setAutoTag] = useState("");

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
    });
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
            {["instagram", "twitter", "facebook", "linkedin", "reddit", "youtube", "tiktok"].map((p) => (
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
  const messages = data?.messages ?? [];

  return (
    <div className="space-y-4">
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
                    "bg-muted text-muted-foreground"
                  }`}>
                    {m.status}
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
            <p className="font-medium">2. Enable platforms in config</p>
            <p className="text-muted-foreground">
              Set <code className="rounded bg-muted px-1">socialBrain.connections.&lt;platform&gt;.enabled: true</code> in <code className="rounded bg-muted px-1">~/.openzigs/config.json</code>.
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

function PlatformCard({ platform: p }: { platform: PlatformConfigEntry }) {
  const statusColor = p.connected
    ? "border-green-500/30 bg-green-500/5"
    : p.configured
      ? "border-yellow-500/30 bg-yellow-500/5"
      : "border-border";

  const statusLabel = p.connected
    ? "Connected"
    : p.configured
      ? "Token Set — Not Enabled"
      : "Not Configured";

  const statusBadgeColor = p.connected
    ? "bg-green-500/10 text-green-600"
    : p.configured
      ? "bg-yellow-500/10 text-yellow-600"
      : "bg-muted text-muted-foreground";

  return (
    <div className={`rounded-lg border p-4 ${statusColor}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <PlatformBadge platform={p.platform} />
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeColor}`}>
            {statusLabel}
          </span>
        </div>
        <span className="text-xs text-muted-foreground capitalize">{p.mode}</span>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Access Token</span>
          <span className={p.configured ? "text-green-600" : "text-muted-foreground"}>
            {p.configured ? "Configured" : "Missing"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Env var: </span>
          <code className="rounded bg-muted px-1">{p.envVar}</code>
        </div>
        <div>
          <span className="text-muted-foreground">Webhook: </span>
          <code className="rounded bg-muted px-1 break-all">{p.webhookPath}</code>
        </div>
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

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    instagram: "bg-pink-500/10 text-pink-600",
    twitter: "bg-sky-500/10 text-sky-600",
    facebook: "bg-blue-500/10 text-blue-600",
    linkedin: "bg-blue-700/10 text-blue-700",
    reddit: "bg-orange-500/10 text-orange-600",
    youtube: "bg-red-500/10 text-red-600",
    tiktok: "bg-fuchsia-500/10 text-fuchsia-600",
  };

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[platform] ?? "bg-muted text-muted-foreground"}`}>
      {platform}
    </span>
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
