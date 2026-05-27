import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialRepository } from "./social-repository.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("SocialRepository", () => {
  let db: Database.Database;
  let repo: SocialRepository;
  const now = new Date("2026-02-21T12:00:00Z");
  const clock = () => now;

  beforeEach(() => {
    db = createTestDb();
    repo = new SocialRepository(db, clock);
    repo.migrate();
  });

  // ── Contacts ──

  describe("contacts", () => {
    it("upserts a new contact", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_123",
        username: "jane_doe",
        displayName: "Jane Doe",
      });

      expect(contact.platform).toBe("twitter");
      expect(contact.username).toBe("jane_doe");
      expect(contact.display_name).toBe("Jane Doe");
      expect(contact.message_count).toBe(0);
      expect(contact.handoff_active).toBe(0);
    });

    it("does not increment message_count on upsert", () => {
      repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_123",
        username: "jane_doe",
      });
      const updated = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_123",
        username: "jane_doe",
      });
      expect(updated.message_count).toBe(0);
    });

    it("gets contact by platform user", () => {
      repo.upsertContact({
        platform: "reddit",
        platformUserId: "u_abc",
        username: "tech_bro",
      });
      const found = repo.getContactByPlatformUser("reddit", "u_abc");
      expect(found?.username).toBe("tech_bro");
    });

    it("lists contacts with pagination", () => {
      for (let i = 0; i < 30; i++) {
        repo.upsertContact({
          platform: "twitter",
          platformUserId: `ig_${i}`,
          username: `user_${i}`,
        });
      }
      const page1 = repo.listContacts({ page: 1, pageSize: 10 });
      expect(page1.data.length).toBe(10);
      expect(page1.total).toBe(30);

      const page3 = repo.listContacts({ page: 3, pageSize: 10 });
      expect(page3.data.length).toBe(10);
    });

    it("filters contacts by platform", () => {
      repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      repo.upsertContact({
        platform: "reddit",
        platformUserId: "r_1",
        username: "user2",
      });
      const result = repo.listContacts({ platform: "twitter" });
      expect(result.total).toBe(1);
      expect(result.data[0].platform).toBe("twitter");
    });

    it("filters contacts by search", () => {
      repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "jane_doe",
      });
      repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_2",
        username: "john_smith",
      });
      const result = repo.listContacts({ search: "jane" });
      expect(result.total).toBe(1);
    });

    it("adds and removes tags", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      repo.addTag(contact.id, "lead");
      repo.addTag(contact.id, "buyer");
      let updated = repo.getContact(contact.id)!;
      expect(JSON.parse(updated.tags)).toEqual(["lead", "buyer"]);

      repo.removeTag(contact.id, "lead");
      updated = repo.getContact(contact.id)!;
      expect(JSON.parse(updated.tags)).toEqual(["buyer"]);
    });

    it("does not duplicate tags", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      repo.addTag(contact.id, "lead");
      repo.addTag(contact.id, "lead");
      const updated = repo.getContact(contact.id)!;
      expect(JSON.parse(updated.tags)).toEqual(["lead"]);
    });

    it("updates contact handoff state", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      repo.updateContact(contact.id, {
        handoff_active: 1,
        handoff_thread_id: "thread_123",
        handoff_channel: "discord",
      });
      const updated = repo.getContact(contact.id)!;
      expect(updated.handoff_active).toBe(1);
      expect(updated.handoff_thread_id).toBe("thread_123");
      expect(updated.handoff_channel).toBe("discord");
    });
  });

  // ── Messages ──

  describe("messages", () => {
    it("inserts and retrieves messages", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      repo.insertMessage({
        contactId: contact.id,
        platform: "twitter",
        direction: "inbound",
        content: "Hello!",
        platformMessageId: "msg_1",
      });
      repo.insertMessage({
        contactId: contact.id,
        platform: "twitter",
        direction: "outbound",
        status: "auto_replied",
        content: "Hi there!",
      });

      const messages = repo.getMessages(contact.id);
      expect(messages.length).toBe(2);
      const directions = messages.map((m) => m.direction);
      expect(directions).toContain("inbound");
      expect(directions).toContain("outbound");
    });

    it("retrieves recent activity", () => {
      const c1 = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      const c2 = repo.upsertContact({
        platform: "reddit",
        platformUserId: "r_1",
        username: "user2",
      });
      repo.insertMessage({
        contactId: c1.id,
        platform: "twitter",
        direction: "inbound",
        content: "msg1",
      });
      repo.insertMessage({
        contactId: c2.id,
        platform: "reddit",
        direction: "inbound",
        content: "msg2",
      });

      const activity = repo.getRecentActivity(10);
      expect(activity.length).toBe(2);
    });
  });

  // ── Comment Automation Rules ──

  describe("comment automation rules", () => {
    it("creates and lists rules", () => {
      repo.createRule({
        name: "Ebook Funnel",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: JSON.stringify(["LINK", "EBOOK"]),
        regex: null,
        comment_reply_template: "Check your DMs!",
        dm_template: "Here's the link: https://example.com",
        dm_delay_seconds: 5,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: "lead-ebook",
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });

      const rules = repo.listRules();
      expect(rules.length).toBe(1);
      expect(rules[0].name).toBe("Ebook Funnel");
      expect(JSON.parse(rules[0].keywords)).toEqual(["LINK", "EBOOK"]);
    });

    it("updates a rule", () => {
      const rule = repo.createRule({
        name: "Test",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: "[]",
        regex: null,
        comment_reply_template: null,
        dm_template: "hello",
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: null,
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });

      const updated = repo.updateRule(rule.id, { name: "Updated", enabled: 0 });
      expect(updated?.name).toBe("Updated");
      expect(updated?.enabled).toBe(0);
    });

    it("deletes a rule", () => {
      const rule = repo.createRule({
        name: "ToDelete",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: "[]",
        regex: null,
        comment_reply_template: null,
        dm_template: "hello",
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: null,
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });

      expect(repo.deleteRule(rule.id)).toBe(true);
      expect(repo.getRule(rule.id)).toBeUndefined();
    });

    it("increments trigger count", () => {
      const rule = repo.createRule({
        name: "Counter",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: "[]",
        regex: null,
        comment_reply_template: null,
        dm_template: "hello",
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: null,
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });

      repo.incrementRuleTriggerCount(rule.id);
      repo.incrementRuleTriggerCount(rule.id);
      expect(repo.getRule(rule.id)?.trigger_count).toBe(2);
    });
  });

  // ── Automation Log ──

  describe("automation log", () => {
    it("inserts and queries log entries", () => {
      const rule = repo.createRule({
        name: "Test",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: '["LINK"]',
        regex: null,
        comment_reply_template: null,
        dm_template: "hello",
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: null,
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });

      repo.insertAutomationLog({
        rule_id: rule.id,
        contact_id: null,
        platform: "twitter",
        post_id: "post_1",
        comment_id: "comment_1",
        username: "user1",
        matched_keyword: "LINK",
        comment_replied: 1,
        dm_sent: 1,
        dm_error: null,
      });

      const log = repo.getAutomationLog({ ruleId: rule.id });
      expect(log.length).toBe(1);
      expect(log[0].matched_keyword).toBe("LINK");
    });

    it("tracks per-user trigger count", () => {
      const rule = repo.createRule({
        name: "Test",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: '["LINK"]',
        regex: null,
        comment_reply_template: null,
        dm_template: "hello",
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: null,
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });

      repo.insertAutomationLog({
        rule_id: rule.id,
        contact_id: null,
        platform: "twitter",
        post_id: null,
        comment_id: "c1",
        username: "user1",
        matched_keyword: "LINK",
        comment_replied: 1,
        dm_sent: 1,
        dm_error: null,
      });

      expect(repo.getUserTriggerCount(rule.id, "user1")).toBe(1);
      expect(repo.getUserTriggerCount(rule.id, "user2")).toBe(0);
    });
  });

  // ── Stats ──

  describe("stats", () => {
    it("returns aggregate stats", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "user1",
      });
      repo.insertMessage({
        contactId: c.id,
        platform: "twitter",
        direction: "inbound",
        content: "hi",
      });
      repo.updateContact(c.id, { handoff_active: 1 });

      const stats = repo.getStats();
      expect(stats.totalContacts).toBe(1);
      expect(stats.activeHandoffs).toBe(1);
      expect(stats.totalMessages).toBe(1);
      expect(stats.messagesLast24h).toBe(1);
    });
  });

  // ── CSV Export ──

  describe("CSV export", () => {
    it("exports contacts as CSV", () => {
      repo.upsertContact({
        platform: "twitter",
        platformUserId: "ig_1",
        username: "jane_doe",
        displayName: "Jane",
      });
      repo.addTag(repo.getContactByPlatformUser("twitter", "ig_1")!.id, "lead");

      const csv = repo.exportContactsCsv();
      const lines = csv.split("\n");
      expect(lines[0]).toContain("id,platform,username");
      expect(lines[1]).toContain("jane_doe");
      expect(lines[1]).toContain("lead");
    });
  });

  // ── Follow-Up Sequences ──

  describe("follow-up sequences", () => {
    let ruleId: string;

    beforeEach(() => {
      const rule = repo.createRule({
        name: "FollowUp Test",
        platform: "twitter",
        enabled: 1,
        post_ids: null,
        keywords: "[]",
        regex: null,
        comment_reply_template: null,
        dm_template: "Hi!",
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        max_triggers_total: null,
        auto_tag: null,
        model: null,
        use_ai_reply: 0,
        ai_reply_context: null,
      });
      ruleId = rule.id;
    });

    it("creates and lists follow-up steps", () => {
      repo.createFollowUpStep(ruleId, {
        stepOrder: 0,
        delaySeconds: 3600,
        messageTemplate: "Step 1",
      });
      repo.createFollowUpStep(ruleId, {
        stepOrder: 1,
        delaySeconds: 86400,
        messageTemplate: "Step 2",
      });

      const steps = repo.getFollowUpSteps(ruleId);
      expect(steps).toHaveLength(2);
      expect(steps[0].message_template).toBe("Step 1");
      expect(steps[1].message_template).toBe("Step 2");
    });

    it("deletes a follow-up step", () => {
      const step = repo.createFollowUpStep(ruleId, {
        stepOrder: 0,
        delaySeconds: 3600,
        messageTemplate: "Deletable",
      });
      expect(repo.deleteFollowUpStep(step.id)).toBe(true);
      expect(repo.getFollowUpSteps(ruleId)).toHaveLength(0);
    });

    it("schedules and retrieves pending follow-up jobs", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_1",
        username: "test",
      });
      const step = repo.createFollowUpStep(ruleId, {
        stepOrder: 0,
        delaySeconds: 0,
        messageTemplate: "msg",
      });

      repo.scheduleFollowUp({
        contactId: contact.id,
        ruleId,
        stepId: step.id,
        platform: "twitter",
        platformUserId: "u_1",
        message: "msg",
        scheduledAt: now.toISOString(),
      });

      const pending = repo.getPendingFollowUps(now.toISOString());
      expect(pending).toHaveLength(1);
      expect(pending[0].message).toBe("msg");
    });

    it("marks follow-up as sent", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_2",
        username: "test2",
      });
      const step = repo.createFollowUpStep(ruleId, {
        stepOrder: 0,
        delaySeconds: 0,
        messageTemplate: "msg",
      });

      const job = repo.scheduleFollowUp({
        contactId: contact.id,
        ruleId,
        stepId: step.id,
        platform: "twitter",
        platformUserId: "u_2",
        message: "msg",
        scheduledAt: now.toISOString(),
      });

      repo.markFollowUpSent(job.id);
      const pending = repo.getPendingFollowUps(now.toISOString());
      expect(pending).toHaveLength(0);
    });

    it("marks follow-up as error", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_3",
        username: "test3",
      });
      const step = repo.createFollowUpStep(ruleId, {
        stepOrder: 0,
        delaySeconds: 0,
        messageTemplate: "msg",
      });

      const job = repo.scheduleFollowUp({
        contactId: contact.id,
        ruleId,
        stepId: step.id,
        platform: "twitter",
        platformUserId: "u_3",
        message: "msg",
        scheduledAt: now.toISOString(),
      });

      repo.markFollowUpError(job.id, "timeout");
      const pending = repo.getPendingFollowUps(now.toISOString());
      expect(pending).toHaveLength(0);
    });
  });

  // ── Lead Capture ──

  describe("lead capture", () => {
    it("updates contact with email", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_1",
        username: "lead1",
      });
      const updated = repo.updateContactLead(contact.id, {
        email: "lead1@example.com",
      });
      expect((updated as Record<string, unknown>).email).toBe(
        "lead1@example.com",
      );
      expect((updated as Record<string, unknown>).lead_captured_at).toBe(
        now.toISOString(),
      );
    });

    it("updates contact with phone", () => {
      const contact = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_2",
        username: "lead2",
      });
      const updated = repo.updateContactLead(contact.id, {
        phone: "+15551234567",
      });
      expect((updated as Record<string, unknown>).phone).toBe("+15551234567");
    });

    it("lists leads", () => {
      const c1 = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_3",
        username: "lead3",
      });
      const c2 = repo.upsertContact({
        platform: "reddit",
        platformUserId: "u_4",
        username: "lead4",
      });
      repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_5",
        username: "nolead",
      });

      repo.updateContactLead(c1.id, { email: "a@b.com" });
      repo.updateContactLead(c2.id, { phone: "555-1234" });

      const allLeads = repo.getLeads();
      expect(allLeads).toHaveLength(2);

      const twitterLeads = repo.getLeads({ platform: "twitter" });
      expect(twitterLeads).toHaveLength(1);
      expect(twitterLeads[0].username).toBe("lead3");
    });

    it("returns undefined for nonexistent contact", () => {
      expect(
        repo.updateContactLead("nonexistent", { email: "x@y.com" }),
      ).toBeUndefined();
    });
  });

  // ── Analytics ──

  describe("analytics", () => {
    it("returns per-platform analytics", () => {
      const c1 = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_1",
        username: "user1",
      });
      const c2 = repo.upsertContact({
        platform: "reddit",
        platformUserId: "u_2",
        username: "user2",
      });

      repo.insertMessage({
        contactId: c1.id,
        platform: "twitter",
        direction: "inbound",
        content: "hi",
      });
      repo.insertMessage({
        contactId: c1.id,
        platform: "twitter",
        direction: "outbound",
        status: "auto_replied",
        content: "hello",
      });
      repo.insertMessage({
        contactId: c2.id,
        platform: "reddit",
        direction: "inbound",
        content: "hey",
      });
      repo.insertMessage({
        contactId: c2.id,
        platform: "reddit",
        direction: "inbound",
        status: "escalated",
        content: "help",
      });

      const analytics = repo.getAnalytics();
      expect(analytics).toHaveLength(2);

      const twitter = analytics.find((a) => a.platform === "twitter")!;
      expect(twitter.total_conversations).toBe(1);
      expect(twitter.total_messages_in).toBe(1);
      expect(twitter.total_messages_out).toBe(1);

      const reddit = analytics.find((a) => a.platform === "reddit")!;
      expect(reddit.total_conversations).toBe(1);
      expect(reddit.total_messages_in).toBe(2);
    });

    it("includes lead counts in analytics", () => {
      const c1 = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_3",
        username: "lead",
      });
      repo.insertMessage({
        contactId: c1.id,
        platform: "twitter",
        direction: "inbound",
        content: "hi",
      });
      repo.updateContactLead(c1.id, { email: "test@example.com" });

      const analytics = repo.getAnalytics();
      const twitter = analytics.find((a) => a.platform === "twitter")!;
      expect(twitter.leads_captured).toBe(1);
    });
  });

  // ── Approval Queue ──

  describe("approval queue", () => {
    function createPendingMessage(repo: SocialRepository, contactId: string) {
      return repo.insertMessage({
        contactId,
        platform: "twitter",
        direction: "outbound",
        status: "pending_approval",
        content: "AI generated reply",
        metadata: { confidence: "high", intent: "help", source: "brain_dm" },
      });
    }

    it("lists pending approvals with contact info", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_a",
        username: "alice",
        displayName: "Alice",
      });
      createPendingMessage(repo, c.id);

      const pending = repo.listPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending_approval");
      expect(pending[0].contact_username).toBe("alice");
      expect(pending[0].contact_display_name).toBe("Alice");
    });

    it("getPendingApprovalCount returns correct count", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_b",
        username: "bob",
      });
      expect(repo.getPendingApprovalCount()).toBe(0);

      createPendingMessage(repo, c.id);
      expect(repo.getPendingApprovalCount()).toBe(1);

      createPendingMessage(repo, c.id);
      expect(repo.getPendingApprovalCount()).toBe(2);
    });

    it("approveReply changes status to auto_replied", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_c",
        username: "carol",
      });
      const msg = createPendingMessage(repo, c.id)!;

      const approved = repo.approveReply(msg.id);
      expect(approved).toBeDefined();
      expect(approved!.status).toBe("auto_replied");
      const meta = JSON.parse(approved!.metadata);
      expect(meta.approved_at).toBe(now.toISOString());
      expect(repo.getPendingApprovalCount()).toBe(0);
    });

    it("rejectReply changes status to rejected", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_d",
        username: "dave",
      });
      const msg = createPendingMessage(repo, c.id)!;

      const rejected = repo.rejectReply(msg.id);
      expect(rejected).toBeDefined();
      expect(rejected!.status).toBe("rejected");
      const meta = JSON.parse(rejected!.metadata);
      expect(meta.rejected_at).toBe(now.toISOString());
      expect(repo.getPendingApprovalCount()).toBe(0);
    });

    it("editAndApproveReply updates content and approves", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_e",
        username: "eve",
      });
      const msg = createPendingMessage(repo, c.id)!;

      const edited = repo.editAndApproveReply(msg.id, "Human-edited reply");
      expect(edited).toBeDefined();
      expect(edited!.status).toBe("auto_replied");
      expect(edited!.content).toBe("Human-edited reply");
      const meta = JSON.parse(edited!.metadata);
      expect(meta.approved_at).toBe(now.toISOString());
      expect(meta.edited).toBeTruthy();
    });

    it("approveReply is a no-op for already approved messages", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_f",
        username: "frank",
      });
      const msg = createPendingMessage(repo, c.id)!;

      repo.approveReply(msg.id);
      // Second approve — should not change anything (already approved, no longer pending)
      const result = repo.approveReply(msg.id);
      expect(result!.status).toBe("auto_replied");
    });

    it("listPendingApprovals paginates correctly", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_g",
        username: "grace",
      });
      for (let i = 0; i < 5; i++) {
        createPendingMessage(repo, c.id);
      }

      const page1 = repo.listPendingApprovals(2, 0);
      expect(page1).toHaveLength(2);

      const page2 = repo.listPendingApprovals(2, 2);
      expect(page2).toHaveLength(2);

      const page3 = repo.listPendingApprovals(2, 4);
      expect(page3).toHaveLength(1);
    });

    it("insertManualReply stores outbound message with manual_reply source", () => {
      const c = repo.upsertContact({
        platform: "twitter",
        platformUserId: "u_h",
        username: "heidi",
      });

      const msg = repo.insertManualReply({
        contactId: c.id,
        platform: "twitter",
        content: "Hello from human!",
      });

      expect(msg).not.toBeNull();
      expect(msg!.direction).toBe("outbound");
      expect(msg!.status).toBe("auto_replied");
      expect(msg!.content).toBe("Hello from human!");
      const meta = JSON.parse(msg!.metadata);
      expect(meta.source).toBe("manual_reply");
    });
  });

  // ── Pinterest & TikTok platform roundtrip (#1156) ──

  describe("pinterest & tiktok platform roundtrip", () => {
    it.each(["pinterest", "tiktok"] as const)(
      "persists and retrieves contacts + messages for %s",
      (platform) => {
        const contact = repo.upsertContact({
          platform,
          platformUserId: `${platform}_user_1`,
          username: `${platform}_user`,
          displayName: `${platform} User`,
        });
        expect(contact.platform).toBe(platform);

        const msg = repo.insertMessage({
          contactId: contact.id,
          platform,
          direction: "inbound",
          status: "received",
          platformMessageId: `${platform}_msg_1`,
          content: "great post!",
          metadata: { source: "brain_comment" },
        });
        expect(msg).not.toBeNull();
        expect(msg!.platform).toBe(platform);

        const found = repo.getContactByPlatformUser(
          platform,
          `${platform}_user_1`,
        );
        expect(found?.id).toBe(contact.id);

        const messages = repo.getMessages(contact.id);
        expect(messages.length).toBe(1);
        expect(messages[0].content).toBe("great post!");
      },
    );
  });
});
