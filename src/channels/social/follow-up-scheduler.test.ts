import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialRepository } from "./social-repository.js";
import { FollowUpScheduler } from "./follow-up-scheduler.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("FollowUpScheduler", () => {
  let db: Database.Database;
  let repo: SocialRepository;
  let scheduler: FollowUpScheduler;
  const now = new Date("2026-02-21T12:00:00Z");
  const clock = () => now;
  let sendDm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    repo = new SocialRepository(db, clock);
    repo.migrate();
    sendDm = vi.fn().mockResolvedValue(undefined);
    scheduler = new FollowUpScheduler({ repository: repo, sendDm, clock, checkIntervalMs: 60_000 });
  });

  it("schedules follow-up steps for a rule", () => {
    // Create a rule
    const rule = repo.createRule({
      name: "promo",
      platform: "twitter",
      enabled: 1,
      post_ids: null,
      keywords: '["deal"]',
      regex: null,
      comment_reply_template: null,
      dm_template: "Check out our deals!",
      dm_delay_seconds: 0,
      max_triggers_per_user: 1,
      max_triggers_total: null,
      auto_tag: null,
      model: null,
      use_ai_reply: 0,
      ai_reply_context: null,
    });

    // Add follow-up steps
    repo.createFollowUpStep(rule.id, { stepOrder: 0, delaySeconds: 3600, messageTemplate: "Did you check our deals, {{username}}?" });
    repo.createFollowUpStep(rule.id, { stepOrder: 1, delaySeconds: 86400, messageTemplate: "Last chance, {{username}}!" });

    // Create a contact
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_1", username: "testuser" });

    // Schedule follow-ups
    scheduler.scheduleForRule(rule.id, { id: contact.id, platform: "twitter", platformUserId: "u_1" }, { username: "testuser" });

    // Verify jobs were scheduled
    const futureTime = new Date(now.getTime() + 2 * 86400 * 1000).toISOString();
    const jobs = repo.getPendingFollowUps(futureTime);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].message).toBe("Did you check our deals, testuser?");
    expect(jobs[1].message).toBe("Last chance, testuser!");
  });

  it("processes pending follow-ups and sends DMs", async () => {
    const rule = repo.createRule({
      name: "test",
      platform: "twitter",
      enabled: 1,
      post_ids: null,
      keywords: "[]",
      regex: null,
      comment_reply_template: null,
      dm_template: "Hi",
      dm_delay_seconds: 0,
      max_triggers_per_user: 1,
      max_triggers_total: null,
      auto_tag: null,
      model: null,
      use_ai_reply: 0,
      ai_reply_context: null,
    });

    const step = repo.createFollowUpStep(rule.id, { stepOrder: 0, delaySeconds: 0, messageTemplate: "Follow-up msg" });
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_2", username: "bob" });

    // Schedule a job that is already due
    repo.scheduleFollowUp({
      contactId: contact.id,
      ruleId: rule.id,
      stepId: step.id,
      platform: "twitter",
      platformUserId: "u_2",
      message: "Follow-up msg",
      scheduledAt: new Date(now.getTime() - 1000).toISOString(), // 1s ago
    });

    const sent = await scheduler.processPending();
    expect(sent).toBe(1);
    expect(sendDm).toHaveBeenCalledWith("twitter", "u_2", "Follow-up msg");

    // Verify job is marked as sent
    const remaining = repo.getPendingFollowUps(now.toISOString());
    expect(remaining).toHaveLength(0);
  });

  it("marks follow-up as error on DM failure", async () => {
    sendDm.mockRejectedValue(new Error("API rate limit"));

    const rule = repo.createRule({
      name: "test",
      platform: "twitter",
      enabled: 1,
      post_ids: null,
      keywords: "[]",
      regex: null,
      comment_reply_template: null,
      dm_template: "Hi",
      dm_delay_seconds: 0,
      max_triggers_per_user: 1,
      max_triggers_total: null,
      auto_tag: null,
      model: null,
      use_ai_reply: 0,
      ai_reply_context: null,
    });

    const step = repo.createFollowUpStep(rule.id, { stepOrder: 0, delaySeconds: 0, messageTemplate: "msg" });
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_3", username: "charlie" });

    repo.scheduleFollowUp({
      contactId: contact.id,
      ruleId: rule.id,
      stepId: step.id,
      platform: "twitter",
      platformUserId: "u_3",
      message: "msg",
      scheduledAt: new Date(now.getTime() - 1000).toISOString(),
    });

    const errorHandler = vi.fn();
    scheduler.on("error", errorHandler);

    const sent = await scheduler.processPending();
    expect(sent).toBe(0);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].error).toBe("API rate limit");
  });

  it("does not process future follow-ups", async () => {
    const rule = repo.createRule({
      name: "delayed",
      platform: "twitter",
      enabled: 1,
      post_ids: null,
      keywords: "[]",
      regex: null,
      comment_reply_template: null,
      dm_template: "Hi",
      dm_delay_seconds: 0,
      max_triggers_per_user: 1,
      max_triggers_total: null,
      auto_tag: null,
      model: null,
      use_ai_reply: 0,
      ai_reply_context: null,
    });

    const step = repo.createFollowUpStep(rule.id, { stepOrder: 0, delaySeconds: 3600, messageTemplate: "Future msg" });
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_4", username: "future" });

    repo.scheduleFollowUp({
      contactId: contact.id,
      ruleId: rule.id,
      stepId: step.id,
      platform: "twitter",
      platformUserId: "u_4",
      message: "Future msg",
      scheduledAt: new Date(now.getTime() + 3600_000).toISOString(), // 1h in future
    });

    const sent = await scheduler.processPending();
    expect(sent).toBe(0);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("emits sent event on success", async () => {
    const rule = repo.createRule({
      name: "e",
      platform: "reddit",
      enabled: 1,
      post_ids: null,
      keywords: "[]",
      regex: null,
      comment_reply_template: null,
      dm_template: "Hi",
      dm_delay_seconds: 0,
      max_triggers_per_user: 1,
      max_triggers_total: null,
      auto_tag: null,
      model: null,
      use_ai_reply: 0,
      ai_reply_context: null,
    });

    const step = repo.createFollowUpStep(rule.id, { stepOrder: 0, delaySeconds: 0, messageTemplate: "msg" });
    const contact = repo.upsertContact({ platform: "reddit", platformUserId: "u_5", username: "eve" });

    repo.scheduleFollowUp({
      contactId: contact.id,
      ruleId: rule.id,
      stepId: step.id,
      platform: "reddit",
      platformUserId: "u_5",
      message: "msg",
      scheduledAt: new Date(now.getTime() - 1).toISOString(),
    });

    const sentHandler = vi.fn();
    scheduler.on("sent", sentHandler);
    await scheduler.processPending();
    expect(sentHandler).toHaveBeenCalledTimes(1);
    expect(sentHandler.mock.calls[0][0].job.contact_id).toBe(contact.id);
  });

  it("returns 0 when no sendDm is configured", async () => {
    const noDmScheduler = new FollowUpScheduler({ repository: repo, clock });
    const sent = await noDmScheduler.processPending();
    expect(sent).toBe(0);
  });
});
