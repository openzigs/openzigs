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
      expect(contact.message_count).toBe(1);
      expect(contact.handoff_active).toBe(0);
    });

    it("increments message_count on upsert", () => {
      repo.upsertContact({ platform: "twitter", platformUserId: "ig_123", username: "jane" });
      const updated = repo.upsertContact({ platform: "twitter", platformUserId: "ig_123", username: "jane" });
      expect(updated.message_count).toBe(2);
    });

    it("gets contact by platform user", () => {
      repo.upsertContact({ platform: "reddit", platformUserId: "u_abc", username: "tech_bro" });
      const found = repo.getContactByPlatformUser("reddit", "u_abc");
      expect(found?.username).toBe("tech_bro");
    });

    it("lists contacts with pagination", () => {
      for (let i = 0; i < 30; i++) {
        repo.upsertContact({ platform: "twitter", platformUserId: `ig_${i}`, username: `user_${i}` });
      }
      const page1 = repo.listContacts({ page: 1, pageSize: 10 });
      expect(page1.data.length).toBe(10);
      expect(page1.total).toBe(30);

      const page3 = repo.listContacts({ page: 3, pageSize: 10 });
      expect(page3.data.length).toBe(10);
    });

    it("filters contacts by platform", () => {
      repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
      repo.upsertContact({ platform: "reddit", platformUserId: "r_1", username: "user2" });
      const result = repo.listContacts({ platform: "twitter" });
      expect(result.total).toBe(1);
      expect(result.data[0].platform).toBe("twitter");
    });

    it("filters contacts by search", () => {
      repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "jane_doe" });
      repo.upsertContact({ platform: "twitter", platformUserId: "ig_2", username: "john_smith" });
      const result = repo.listContacts({ search: "jane" });
      expect(result.total).toBe(1);
    });

    it("adds and removes tags", () => {
      const contact = repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
      repo.addTag(contact.id, "lead");
      repo.addTag(contact.id, "buyer");
      let updated = repo.getContact(contact.id)!;
      expect(JSON.parse(updated.tags)).toEqual(["lead", "buyer"]);

      repo.removeTag(contact.id, "lead");
      updated = repo.getContact(contact.id)!;
      expect(JSON.parse(updated.tags)).toEqual(["buyer"]);
    });

    it("does not duplicate tags", () => {
      const contact = repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
      repo.addTag(contact.id, "lead");
      repo.addTag(contact.id, "lead");
      const updated = repo.getContact(contact.id)!;
      expect(JSON.parse(updated.tags)).toEqual(["lead"]);
    });

    it("updates contact handoff state", () => {
      const contact = repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
      repo.updateContact(contact.id, { handoff_active: 1, handoff_thread_id: "thread_123", handoff_channel: "discord" });
      const updated = repo.getContact(contact.id)!;
      expect(updated.handoff_active).toBe(1);
      expect(updated.handoff_thread_id).toBe("thread_123");
      expect(updated.handoff_channel).toBe("discord");
    });
  });

  // ── Messages ──

  describe("messages", () => {
    it("inserts and retrieves messages", () => {
      const contact = repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
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
      const c1 = repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
      const c2 = repo.upsertContact({ platform: "reddit", platformUserId: "r_1", username: "user2" });
      repo.insertMessage({ contactId: c1.id, platform: "twitter", direction: "inbound", content: "msg1" });
      repo.insertMessage({ contactId: c2.id, platform: "reddit", direction: "inbound", content: "msg2" });

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
      });

      repo.insertAutomationLog({
        rule_id: rule.id, contact_id: null, platform: "twitter",
        post_id: null, comment_id: "c1", username: "user1",
        matched_keyword: "LINK", comment_replied: 1, dm_sent: 1, dm_error: null,
      });

      expect(repo.getUserTriggerCount(rule.id, "user1")).toBe(1);
      expect(repo.getUserTriggerCount(rule.id, "user2")).toBe(0);
    });
  });

  // ── Stats ──

  describe("stats", () => {
    it("returns aggregate stats", () => {
      const c = repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "user1" });
      repo.insertMessage({ contactId: c.id, platform: "twitter", direction: "inbound", content: "hi" });
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
      repo.upsertContact({ platform: "twitter", platformUserId: "ig_1", username: "jane_doe", displayName: "Jane" });
      repo.addTag(repo.getContactByPlatformUser("twitter", "ig_1")!.id, "lead");

      const csv = repo.exportContactsCsv();
      const lines = csv.split("\n");
      expect(lines[0]).toContain("id,platform,username");
      expect(lines[1]).toContain("jane_doe");
      expect(lines[1]).toContain("lead");
    });
  });
});
