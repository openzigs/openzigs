/** Shared types for the Social Brain subsystem. */

export type SocialPlatform = "instagram" | "reddit" | "youtube" | "tiktok" | "twitter" | "facebook" | "linkedin";

export type MessageDirection = "inbound" | "outbound";

export type MessageStatus = "received" | "auto_replied" | "escalated" | "failed";

/** Normalised inbound social message — platform adapters produce this. */
export type IncomingSocialMessage = {
  platform: SocialPlatform;
  platformMessageId: string;
  platformUserId: string;
  username: string;
  displayName?: string;
  text: string;
  mediaUrl?: string;
  timestamp: string; // ISO-8601
  metadata?: Record<string, unknown>;
};

/** Normalised inbound comment (for Comment-to-DM automation). */
export type IncomingComment = {
  platform: SocialPlatform;
  postId: string;
  commentId: string;
  userId: string;
  username: string;
  text: string;
  timestamp: string;
};

/** CRM contact row. */
export type Contact = {
  id: string;
  platform: SocialPlatform;
  platform_user_id: string;
  username: string;
  display_name: string;
  tags: string; // JSON array
  notes: string;
  first_seen_at: string;
  last_seen_at: string;
  message_count: number;
  handoff_active: number; // 0 or 1
  handoff_thread_id: string | null;
  handoff_channel: string | null; // "discord" | "telegram"
  created_at: string;
  updated_at: string;
};

/** Social message log row. */
export type SocialMessage = {
  id: string;
  contact_id: string;
  platform: SocialPlatform;
  direction: MessageDirection;
  status: MessageStatus;
  platform_message_id: string;
  content: string;
  metadata: string; // JSON
  created_at: string;
};

/** Comment automation rule row. */
export type CommentRule = {
  id: string;
  name: string;
  platform: SocialPlatform;
  enabled: number; // 0 or 1
  post_ids: string | null; // JSON array or null
  keywords: string; // JSON array
  regex: string | null;
  comment_reply_template: string | null;
  dm_template: string;
  dm_delay_seconds: number;
  max_triggers_per_user: number;
  max_triggers_total: number | null;
  trigger_count: number;
  auto_tag: string | null;
  created_at: string;
  updated_at: string;
};

/** Comment automation log entry row. */
export type AutomationLogEntry = {
  id: string;
  rule_id: string;
  contact_id: string | null;
  platform: SocialPlatform;
  post_id: string | null;
  comment_id: string;
  username: string;
  matched_keyword: string | null;
  comment_replied: number;
  dm_sent: number;
  dm_error: string | null;
  created_at: string;
};

/** Brain response result. */
export type BrainResult = {
  reply: string;
  confidence: "high" | "medium" | "low";
  intent: string;
  ragChunksUsed: string[];
  shouldEscalate: boolean;
};

/** Escalation context passed to the handoff manager. */
export type EscalationContext = {
  brainConfidence: string;
  brainIntent: string;
  ragChunksUsed: string[];
  conversationHistory: SocialMessage[];
  triggerReason: "low_confidence" | "handoff_request" | "manual";
};

/** Social Brain config section. */
export type SocialBrainConfig = {
  enabled?: boolean;
  confidenceThreshold?: "high" | "medium" | "low";
  handoff?: {
    preferredChannel?: "discord" | "telegram";
    discordChannelId?: string;
    telegramChatId?: string;
    autoArchiveMinutes?: number;
  };
  commentAutomation?: {
    enabled?: boolean;
    pollIntervalSeconds?: number;
    maxDmRetries?: number;
    globalRateLimit?: {
      commentRepliesPerHour?: number;
      dmsPerHour?: number;
    };
  };
  connections?: Record<string, {
    enabled?: boolean;
    mode?: "webhook" | "polling";
    pollIntervalSeconds?: number;
    accessToken?: string;
  }>;
};
