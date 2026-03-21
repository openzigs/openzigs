import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type {
  CommentRule,
  IncomingComment,
  SocialPlatform,
} from "./types.js";

export type DmSender = (platform: SocialPlatform, userId: string, text: string) => Promise<void>;
export type CommentReplier = (platform: SocialPlatform, commentId: string, text: string, postId?: string) => Promise<void>;
/** AI reply generator for comment automation. */
export type AiReplyGenerator = (prompt: string, context?: string) => Promise<string>;

export interface CommentRuleEngineOpts {
  repository: SocialRepository;
  sendDm?: DmSender;
  replyToComment?: CommentReplier;
  generateAiReply?: AiReplyGenerator;
}

/** Template variables available in rule templates. */
type TemplateVars = {
  username: string;
  keyword: string;
  post_id: string;
  comment_text: string;
  post_caption: string;
  post_url: string;
};

/**
 * Evaluates incoming comments against automation rules.
 * When a rule matches it replies to the comment and / or sends a DM,
 * respecting rate limits and per-user trigger caps.
 */
export class CommentRuleEngine extends EventEmitter {
  private repository: SocialRepository;
  private sendDm?: DmSender;
  private replyToComment?: CommentReplier;
  private generateAiReply?: AiReplyGenerator;

  constructor(opts: CommentRuleEngineOpts) {
    super();
    this.repository = opts.repository;
    this.sendDm = opts.sendDm;
    this.replyToComment = opts.replyToComment;
    this.generateAiReply = opts.generateAiReply;
  }

  setSendDm(fn: DmSender): void {
    this.sendDm = fn;
  }
  setReplyToComment(fn: CommentReplier): void {
    this.replyToComment = fn;
  }
  setAiReplyGenerator(fn: AiReplyGenerator): void {
    this.generateAiReply = fn;
  }

  /**
   * Evaluate a single comment against all enabled rules for its platform.
   * Returns the list of matched rule IDs.
   */
  async evaluate(comment: IncomingComment): Promise<string[]> {
    // Skip if this comment was already processed (webhook retry / poll overlap)
    if (this.repository.hasCommentBeenProcessed(comment.commentId, comment.platform)) {
      return [];
    }

    const rules = this.repository.listRules(comment.platform);
    const enabled = rules.filter((r) => r.enabled === 1);
    const matched: string[] = [];

    for (const rule of enabled) {
      if (!this.ruleMatchesComment(rule, comment)) continue;
      matched.push(rule.id);
      await this.executeRule(rule, comment);
    }

    return matched;
  }

  /** Log an outbound DM in the social_messages table with post context metadata. */
  private logOutboundDm(comment: IncomingComment, dmText: string, metadata: Record<string, unknown>): void {
    const contact = this.repository.getContactByPlatformUser(comment.platform, comment.userId);
    if (contact) {
      this.repository.insertMessage({
        contactId: contact.id,
        platform: comment.platform,
        direction: "outbound",
        status: "auto_replied",
        content: dmText,
        metadata: { source: "comment-rule-engine", type: "dm", ...metadata },
      });
    }
  }

  /** Log an outbound comment reply in the social_messages table. */
  private logOutboundCommentReply(comment: IncomingComment, replyText: string): void {
    const contact = this.repository.getContactByPlatformUser(comment.platform, comment.userId);
    if (contact) {
      this.repository.insertMessage({
        contactId: contact.id,
        platform: comment.platform,
        direction: "outbound",
        status: "auto_replied",
        content: replyText,
        metadata: { source: "comment-rule-engine", type: "comment_reply", postId: comment.postId, commentId: comment.commentId },
      });
    }
  }

  /** Check if a rule matches the given comment. */
  private ruleMatchesComment(rule: CommentRule, comment: IncomingComment): boolean {
    // Post-scoping: if rule has specific post_ids, check membership
    if (rule.post_ids) {
      const postIds: string[] = JSON.parse(rule.post_ids);
      if (postIds.length > 0 && !postIds.includes(comment.postId)) return false;
    }

    // Max total triggers
    if (rule.max_triggers_total !== null && rule.trigger_count >= rule.max_triggers_total) return false;

    // Keyword matching: case-insensitive word-boundary match
    const keywords: string[] = JSON.parse(rule.keywords);

    let keywordMatched = keywords.length === 0; // no keywords = always match
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (pattern.test(comment.text)) {
        keywordMatched = true;
        break;
      }
    }
    if (!keywordMatched) {
      // Fall back to regex if keywords didn't match
      if (rule.regex) {
        try {
          const re = new RegExp(rule.regex, "i");
          const m = re.exec(comment.text);
          if (m) {
            keywordMatched = true;
          }
        } catch {
          logger.warn(`[CommentRule] Invalid regex in rule ${rule.id}: ${rule.regex}`);
        }
      }
    }

    if (!keywordMatched) return false;

    // Per-user trigger limit
    const userTriggers = this.repository.getUserTriggerCount(rule.id, comment.username);
    if (userTriggers >= rule.max_triggers_per_user) return false;

    return true;
  }

  /** Execute a matched rule: reply to comment and/or send DM. */
  private async executeRule(rule: CommentRule, comment: IncomingComment): Promise<void> {
    // Determine the matched keyword for template interpolation
    const keywords: string[] = JSON.parse(rule.keywords);
    let matchedKeyword = "";
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (pattern.test(comment.text)) {
        matchedKeyword = kw;
        break;
      }
    }
    if (!matchedKeyword && rule.regex) {
      try {
        const m = new RegExp(rule.regex, "i").exec(comment.text);
        if (m) matchedKeyword = m[0];
      } catch { /* already logged in match phase */ }
    }

    const vars: TemplateVars = {
      username: comment.username,
      keyword: matchedKeyword,
      post_id: comment.postId,
      comment_text: comment.text,
      post_caption: comment.postContext?.caption ?? "",
      post_url: comment.postContext?.permalink ?? "",
    };

    let commentReplied = false;
    let dmSent = false;
    let dmError: string | null = null;

    // 1. Reply to comment (AI-generated or template-based)
    if (this.replyToComment) {
      if (rule.use_ai_reply && this.generateAiReply) {
        // AI-powered comment reply
        try {
          const aiPrompt = [
            `Reply to this comment on ${comment.platform}:`,
            `Comment by @${comment.username}: "${comment.text}"`,
            comment.postContext?.caption ? `Post caption: "${comment.postContext.caption}"` : "",
            rule.ai_reply_context ? `Context: ${rule.ai_reply_context}` : "",
            "Keep the reply concise, friendly, and on-brand. Reply with just the text, no quotes.",
          ].filter(Boolean).join("\n");
          const reply = await this.generateAiReply(aiPrompt, rule.ai_reply_context ?? undefined);
          await this.replyToComment(comment.platform, comment.commentId, reply, comment.postId);
          this.logOutboundCommentReply(comment, reply);
          commentReplied = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[CommentRule] AI comment reply failed for rule ${rule.id}: ${msg}`);
        }
      } else if (rule.comment_reply_template) {
        // Template-based comment reply
        try {
          const reply = interpolateTemplate(rule.comment_reply_template, vars);
          await this.replyToComment(comment.platform, comment.commentId, reply, comment.postId);
          this.logOutboundCommentReply(comment, reply);
          commentReplied = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[CommentRule] Comment reply failed for rule ${rule.id}: ${msg}`);
        }
      }
    }

    // 2. Send DM (with optional delay) — skip for platforms without DM support (e.g. YouTube)
    const DM_SUPPORTED_PLATFORMS: Set<string> = new Set(["twitter", "linkedin", "reddit", "instagram", "facebook"]);
    if (this.sendDm && rule.dm_template && DM_SUPPORTED_PLATFORMS.has(comment.platform)) {
      const postMeta = comment.postContext
        ? { postCaption: comment.postContext.caption, postUrl: comment.postContext.permalink, postMediaType: comment.postContext.mediaType, triggeringComment: comment.text }
        : { triggeringComment: comment.text };

      if (rule.dm_delay_seconds > 0) {
        // Schedule DM after delay
        setTimeout(async () => {
          try {
            const dmText = interpolateTemplate(rule.dm_template, vars);
            await this.sendDm!(comment.platform, comment.userId, dmText);
            this.logOutboundDm(comment, dmText, postMeta);
            this.emit("dm_sent", { ruleId: rule.id, username: comment.username });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[CommentRule] Delayed DM failed for rule ${rule.id}: ${msg}`);
            this.emit("dm_failed", { ruleId: rule.id, username: comment.username, error: msg });
          }
        }, rule.dm_delay_seconds * 1000);
        dmSent = true; // scheduled
      } else {
        try {
          const dmText = interpolateTemplate(rule.dm_template, vars);
          await this.sendDm(comment.platform, comment.userId, dmText);
          this.logOutboundDm(comment, dmText, postMeta);
          dmSent = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          dmError = msg;
          logger.error(`[CommentRule] DM failed for rule ${rule.id}: ${msg}`);
        }
      }
    }

    // Auto-tag contact
    if (rule.auto_tag) {
      const contact = this.repository.getContactByPlatformUser(comment.platform, comment.userId);
      if (contact) {
        this.repository.addTag(contact.id, rule.auto_tag);
      }
    }

    // Log the automation execution
    this.repository.insertAutomationLog({
      rule_id: rule.id,
      contact_id: this.repository.getContactByPlatformUser(comment.platform, comment.userId)?.id ?? null,
      platform: comment.platform,
      post_id: comment.postId,
      comment_id: comment.commentId,
      username: comment.username,
      matched_keyword: matchedKeyword || null,
      comment_replied: commentReplied ? 1 : 0,
      dm_sent: dmSent ? 1 : 0,
      dm_error: dmError,
    });

    // Increment trigger count
    this.repository.incrementRuleTriggerCount(rule.id);

    this.emit("rule_triggered", {
      ruleId: rule.id,
      commentId: comment.commentId,
      username: comment.username,
      commentReplied,
      dmSent,
      postContext: comment.postContext ?? null,
    });

    logger.info(
      `[CommentRule] Rule "${rule.name}" triggered by @${comment.username} ` +
        `(keyword: ${matchedKeyword || "regex"}, dm: ${dmSent}, reply: ${commentReplied})`,
    );
  }
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Interpolate {{variable}} in a template string. */
function interpolateTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return key in vars ? vars[key as keyof TemplateVars] : `{{${key}}}`;
  });
}
