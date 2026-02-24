import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CommentRuleEngine } from "./comment-rule-engine.js";
import { SocialRepository } from "./social-repository.js";
import type { IncomingComment, CommentRule } from "./types.js";

function createInMemoryRepo(): SocialRepository {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new SocialRepository(db);
  repo.migrate();
  return repo;
}

function makeComment(overrides: Partial<IncomingComment> = {}): IncomingComment {
  return {
    platform: "instagram",
    postId: "post_1",
    commentId: "comment_1",
    userId: "user_1",
    username: "testuser",
    text: "I love this product!",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createRule(repo: SocialRepository, overrides: Partial<Omit<CommentRule, "id" | "trigger_count" | "created_at" | "updated_at">> = {}): CommentRule {
  return repo.createRule({
    name: "Test Rule",
    platform: "instagram",
    enabled: 1,
    post_ids: null,
    keywords: JSON.stringify(["love", "amazing"]),
    regex: null,
    comment_reply_template: "Thanks {{username}}!",
    dm_template: "Hey {{username}}, thanks for the love! Check out {{post_url}}",
    dm_delay_seconds: 0,
    max_triggers_per_user: 3,
    max_triggers_total: null,
    auto_tag: null,
    ...overrides,
  });
}

describe("CommentRuleEngine", () => {
  let repo: SocialRepository;
  let sendDm: ReturnType<typeof vi.fn>;
  let replyToComment: ReturnType<typeof vi.fn>;
  let engine: CommentRuleEngine;

  beforeEach(() => {
    repo = createInMemoryRepo();
    sendDm = vi.fn().mockResolvedValue(undefined);
    replyToComment = vi.fn().mockResolvedValue(undefined);
    engine = new CommentRuleEngine({ repository: repo, sendDm, replyToComment });
    repo.upsertContact({ platform: "instagram", platformUserId: "user_1", username: "testuser" });
  });

  it("keyword match triggers DM", async () => {
    createRule(repo);
    const comment = makeComment({ text: "I love this product!" });
    const matched = await engine.evaluate(comment);

    expect(matched).toHaveLength(1);
    expect(sendDm).toHaveBeenCalledWith("instagram", "user_1", expect.stringContaining("thanks for the love"));
  });

  it("keyword match triggers comment reply when template exists", async () => {
    createRule(repo);
    const comment = makeComment({ text: "I love it!" });
    await engine.evaluate(comment);

    expect(replyToComment).toHaveBeenCalledWith("instagram", "comment_1", expect.stringContaining("Thanks testuser"));
  });

  it("regex match triggers rule when keywords don't match", async () => {
    createRule(repo, { keywords: JSON.stringify([]), regex: "\\bcheck\\s?out\\b" });
    const comment = makeComment({ text: "Can you check out my profile?" });
    const matched = await engine.evaluate(comment);

    expect(matched).toHaveLength(1);
    expect(sendDm).toHaveBeenCalled();
  });

  it("per-user trigger limit prevents repeat triggers", async () => {
    createRule(repo, { max_triggers_per_user: 1 });
    const comment1 = makeComment({ commentId: "c1", text: "I love it!" });
    const comment2 = makeComment({ commentId: "c2", text: "I love it again!" });

    await engine.evaluate(comment1);
    const matched2 = await engine.evaluate(comment2);

    expect(matched2).toHaveLength(0);
    expect(sendDm).toHaveBeenCalledTimes(1);
  });

  it("no match returns empty array and no actions", async () => {
    createRule(repo);
    const comment = makeComment({ text: "Boring content here" });
    const matched = await engine.evaluate(comment);

    expect(matched).toHaveLength(0);
    expect(sendDm).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("disabled rules are skipped", async () => {
    createRule(repo, { enabled: 0 });
    const comment = makeComment({ text: "I love this!" });
    const matched = await engine.evaluate(comment);

    expect(matched).toHaveLength(0);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("case-insensitive keyword matching", async () => {
    createRule(repo, { keywords: JSON.stringify(["LOVE"]) });
    const comment = makeComment({ text: "i love it!" });
    const matched = await engine.evaluate(comment);

    expect(matched).toHaveLength(1);
  });

  it("auto-tags contact on rule match", async () => {
    createRule(repo, { auto_tag: "engaged" });
    const comment = makeComment({ text: "I love this!" });
    await engine.evaluate(comment);

    const contact = repo.getContactByPlatformUser("instagram", "user_1");
    expect(contact).toBeDefined();
    const tags = JSON.parse(contact!.tags);
    expect(tags).toContain("engaged");
  });

  it("logs automation execution in automation_log", async () => {
    const rule = createRule(repo);
    const comment = makeComment({ text: "I love it!" });
    await engine.evaluate(comment);

    const log = repo.getAutomationLog({ ruleId: rule.id });
    expect(log).toHaveLength(1);
    expect(log[0].username).toBe("testuser");
    expect(log[0].dm_sent).toBe(1);
    expect(log[0].comment_replied).toBe(1);
  });

  it("emits 'rule_triggered' event with match details", async () => {
    const handler = vi.fn();
    engine.on("rule_triggered", handler);

    createRule(repo);
    const comment = makeComment({ text: "I love it!" });
    await engine.evaluate(comment);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: "comment_1",
        username: "testuser",
        commentReplied: true,
        dmSent: true,
      }),
    );
  });

  it("max_triggers_total prevents further triggers after limit", async () => {
    createRule(repo, { max_triggers_total: 1, max_triggers_per_user: 99 });
    const c1 = makeComment({ commentId: "c1", userId: "u1", username: "user1", text: "I love it!" });
    repo.upsertContact({ platform: "instagram", platformUserId: "u1", username: "user1" });
    await engine.evaluate(c1);

    const c2 = makeComment({ commentId: "c2", userId: "u2", username: "user2", text: "I love it too!" });
    repo.upsertContact({ platform: "instagram", platformUserId: "u2", username: "user2" });
    const matched2 = await engine.evaluate(c2);

    expect(matched2).toHaveLength(0);
    expect(sendDm).toHaveBeenCalledTimes(1);
  });

  it("post_ids scoping restricts which posts trigger the rule", async () => {
    createRule(repo, { post_ids: JSON.stringify(["post_99"]) });
    const comment = makeComment({ postId: "post_1", text: "I love it!" });
    const matched = await engine.evaluate(comment);

    expect(matched).toHaveLength(0);

    const comment2 = makeComment({ postId: "post_99", commentId: "c2", text: "I love it!" });
    const matched2 = await engine.evaluate(comment2);
    expect(matched2).toHaveLength(1);
  });

  it("template variables are interpolated correctly", async () => {
    createRule(repo, {
      dm_template: "Hi {{username}}, you said '{{comment_text}}' on post {{post_id}}",
      comment_reply_template: null,
    });
    const comment = makeComment({ text: "I love widgets!", username: "fanuser", userId: "user_1" });
    await engine.evaluate(comment);

    expect(sendDm).toHaveBeenCalledWith(
      "instagram",
      "user_1",
      "Hi fanuser, you said 'I love widgets!' on post post_1",
    );
  });
});
