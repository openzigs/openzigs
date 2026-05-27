/** Shared types for the Social Brain subsystem. */

export type SocialPlatform =
  | "reddit"
  | "youtube"
  | "tiktok"
  | "twitter"
  | "linkedin"
  | "instagram"
  | "facebook"
  | "pinterest";

export type MessageDirection = "inbound" | "outbound";

export type MessageStatus =
  | "received"
  | "auto_replied"
  | "escalated"
  | "failed"
  | "pending_approval"
  | "rejected";

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

/** Cached post/media context fetched from the platform API. */
export type PostContext = {
  postId: string;
  platform: SocialPlatform;
  caption: string;
  permalink: string;
  mediaType: string; // IMAGE, VIDEO, CAROUSEL_ALBUM, etc.
  mediaUrl: string;
  authorUsername: string;
  publishedAt: string; // ISO-8601
  cachedAt: string; // ISO-8601
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
  postContext?: PostContext;
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
  model: string | null;
  /** Use AI to generate comment replies instead of template. */
  use_ai_reply: number; // 0 or 1
  /** Additional context for AI-generated replies. */
  ai_reply_context: string | null;
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

/** Follow-up sequence step. */
export type FollowUpStep = {
  id: string;
  rule_id: string;
  step_order: number;
  delay_seconds: number;
  message_template: string;
  created_at: string;
};

/** Pending follow-up job. */
export type FollowUpJob = {
  id: string;
  contact_id: string;
  rule_id: string;
  step_id: string;
  platform: SocialPlatform;
  platform_user_id: string;
  message: string;
  scheduled_at: string;
  sent_at: string | null;
  error: string | null;
  created_at: string;
};

/** Lead data captured from DM conversations. */
export type LeadData = {
  email: string | null;
  phone: string | null;
  captured_at: string;
  source: string; // "dm_extraction" | "manual"
};

/** Conversation analytics row. */
export type ConversationAnalytics = {
  platform: SocialPlatform;
  total_conversations: number;
  total_messages_in: number;
  total_messages_out: number;
  avg_response_time_ms: number;
  auto_reply_rate: number;
  escalation_rate: number;
  leads_captured: number;
};

/** Social Brain config section. */
export type SocialBrainConfig = {
  enabled?: boolean;
  confidenceThreshold?: "high" | "medium" | "low";
  commentBrainEnabled?: boolean;
  approvalRequired?: boolean;
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
  followerWelcome?: {
    enabled?: boolean;
    /** Per-platform welcome message templates */
    messages?: Partial<Record<SocialPlatform, string>>;
    /** Delay in seconds before sending the welcome DM */
    delaySeconds?: number;
  };
  notifications?: {
    enabled?: boolean;
    telegram?: boolean;
    discord?: boolean;
    web?: boolean;
  };
  connections?: Record<
    string,
    {
      enabled?: boolean;
      mode?: "webhook" | "polling" | "browser";
      pollIntervalSeconds?: number;
      accessToken?: string;
    }
  >;
};
