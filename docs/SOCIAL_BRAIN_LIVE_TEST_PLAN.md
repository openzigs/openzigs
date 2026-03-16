# Social Brain — Live Testing Playbook

> **Purpose:** Hands-on testing guide for verifying Social Brain features end-to-end with real social media posts, comments, DMs, and automation rules.
> **Last Updated:** 2026-03-16
> **Complements:** [SOCIAL_BRAIN_TEST_PLAN.md](SOCIAL_BRAIN_TEST_PLAN.md) (unit/integration tests) and [SOCIAL_BRAIN_GUIDE.md](SOCIAL_BRAIN_GUIDE.md) (setup guide)

---

## Table of Contents

1. [Prerequisites & Account Setup](#1-prerequisites--account-setup)
2. [Architecture Recap: How Posts Become Comments](#2-architecture-recap-how-posts-become-comments)
3. [Creating Test Content (Posts)](#3-creating-test-content-posts)
4. [Test Suite A: Comment-to-DM Automation](#4-test-suite-a-comment-to-dm-automation)
5. [Test Suite B: AI-Powered Comment Replies](#5-test-suite-b-ai-powered-comment-replies)
6. [Test Suite C: Follow-Up Sequences](#6-test-suite-c-follow-up-sequences)
7. [Test Suite D: Lead Capture](#7-test-suite-d-lead-capture)
8. [Test Suite E: Conversation Analytics](#8-test-suite-e-conversation-analytics)
9. [Test Suite F: Follower Welcome DMs](#9-test-suite-f-follower-welcome-dms)
10. [Test Suite G: Human Handoff & Escalation](#10-test-suite-g-human-handoff--escalation)
11. [Test Suite H: Multi-Platform Verification](#11-test-suite-h-multi-platform-verification) (Twitter, Reddit, YouTube, LinkedIn, Instagram, Facebook, Pinterest)
12. [Simulated Testing (No Real Accounts)](#12-simulated-testing-no-real-accounts)
13. [Outbox Integration: How Posting Works](#13-outbox-integration-how-posting-works)
14. [Platform Integration Status](#14-platform-integration-status)
15. [Verification Checklist](#15-verification-checklist)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Prerequisites & Account Setup

### Which Accounts Does Social Brain Use?

Social Brain uses **your own social media accounts** — the ones whose API credentials you configure via environment variables. It does **not** have a shared/default account. Each platform requires its own credentials:

| Platform | Env Vars Required | How to Get |
|----------|-------------------|------------|
| **Twitter/X** | `TWITTER_BEARER_TOKEN`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET` | [developer.x.com](https://developer.x.com) → Create App → Generate Keys |
| **YouTube** | `YOUTUBE_API_KEY` (read), `YOUTUBE_OAUTH_CLIENT_ID` + `YOUTUBE_OAUTH_CLIENT_SECRET` (write) | [console.cloud.google.com](https://console.cloud.google.com) → YouTube Data API v3 |
| **LinkedIn** | `LINKEDIN_ACCESS_TOKEN` | [linkedin.com/developers](https://www.linkedin.com/developers/) → Create App → OAuth 2.0 |
| **Reddit** | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → Create script app |
| **TikTok** | `TIKTOK_ACCESS_TOKEN` | [developers.tiktok.com](https://developers.tiktok.com) |
| **Instagram** | `INSTAGRAM_ACCESS_TOKEN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | [developers.facebook.com](https://developers.facebook.com) → Create App → Instagram Graph API → Generate Long-Lived Token |
| **Facebook** | `FACEBOOK_PAGE_TOKEN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | [developers.facebook.com](https://developers.facebook.com) → Create App → Page Access Token (via Graph Explorer or OAuth flow) |
| **Pinterest** | `PINTEREST_ACCESS_TOKEN` | [developers.pinterest.com](https://developers.pinterest.com) → Create App → OAuth 2.0 token |

### Does Social Brain Use the Same MCP Servers as Outbox?

**Yes and no.** Both systems rely on the same `LocalMcpServerManager` and the same external MCP servers under `external/`, but they call them differently:

| System | How It Uses MCP Servers | LLM Involved? |
|--------|------------------------|---------------|
| **Social Brain** (DmDispatcher) | Calls MCP tools **directly** via `LocalMcpServerManager.callTool()` — e.g., `twitter_send_dm`, `reddit_reply_to_comment` | No (programmatic) |
| **Outbox** (OutboxPoller) | Submits a **background task** to the TaskEngine. The LLM agent picks the right MCP tool — e.g., `twitter-post-tweet`, `pinterest-create-pin` | Yes (LLM agent decides) |

**Same credentials, same MCP server processes, different callers.** If your Twitter MCP server is running for Outbox posting, Social Brain's DM dispatch will use it too.

### Pre-Flight Checks

Before running live tests, verify:

```bash
# 1. Server is running
curl http://localhost:3000/health

# 2. Check which MCP servers are active
curl http://localhost:3000/api/admin/mcp/local-servers | python3 -m json.tool

# 3. Verify Social Brain is enabled
curl http://localhost:3000/api/social/config | python3 -m json.tool

# 4. Check platform connections
curl http://localhost:3000/api/social/connections | python3 -m json.tool

# 5. Verify existing automation rules
curl http://localhost:3000/api/social/rules | python3 -m json.tool
```

### Platform Support Matrix

Not all platforms have the same level of Social Brain integration. This matrix shows what's currently wired in:

| Platform | Outbox (Publish) | Comment Ingestion | Comment Rule Engine | DM Dispatch | Reply Dispatch | Post Context Enrichment | MCP Server |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Twitter** | ✅ | ✅ Webhook | ✅ | ✅ `twitter_send_dm` | ✅ `twitter_post_tweet` | ✅ `TwitterApiClient` | `twitter` (Node.js) |
| **Reddit** | ✅ | ✅ Polling | ✅ | ✅ `reddit_send_message` | ✅ `reddit_reply_to_comment` | ❌ | `reddit` (Node.js) |
| **YouTube** | ✅ | ✅ Polling | ✅ | ❌ (no API) | ✅ `yt_reply_to_comment` | ✅ `YouTubeApiClient` | `youtube` (Node.js) |
| **LinkedIn** | ✅ | ✅ Polling | ✅ | ✅ `linkedin_send_message` | ✅ `linkedin_reply_to_comment` | ❌ | `linkedin` (Node.js) |
| **TikTok** | ❌ | ❌ | In type but no adapter | ❌ | ❌ | ❌ | `tiktok` (Node.js) |
| **Instagram** | ✅ `publish_media` | ✅ Webhook | ✅ | ✅ `send_dm` | ✅ `reply_to_comment` | ✅ `InstagramApiClient` | `instagram` (Python) |
| **Facebook** | ✅ `fb_publish_post` | ✅ Webhook | ✅ | ✅ `fb_send_message` | ✅ `fb_reply_to_comment` | ✅ `FacebookApiClient` | `facebook` (Python) |
| **Pinterest** | ✅ `pinterest-create-pin` | N/A (no comments) | N/A | N/A (no DM API) | N/A (no comments) | N/A | Built-in (direct API) |

**Key takeaway:** All seven platforms including Instagram and Facebook are fully wired into the Social Brain automation pipeline. `SocialPlatform` type, `PLATFORM_DM_MAP`, ingestion adapters, and `PostContextService` clients are implemented for both. Pinterest is publishing/analytics only (no comment system).

### Recommended Test Account Strategy

Use **dedicated test accounts** (not your main brand accounts):

- **Twitter:** Create a secondary account for testing
- **Reddit:** Use a throwaway or test subreddit (e.g., r/test)
- **YouTube:** Create an unlisted video (invisible to public)
- **LinkedIn:** Use your personal profile with test posts set to "Only me" visibility
- **Instagram:** Use a test Business/Creator account (Personal accounts can't use Graph API)
- **Facebook:** Create a test Page (not your personal profile) — Facebook API operates on Pages
- **Pinterest:** Use a business account (required for API access)

---

## 2. Architecture Recap: How Posts Become Comments

Understanding the data flow is critical for knowing what to test:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CONTENT CREATION                             │
│                                                                      │
│  Outbox / Manual Post                                                │
│  ┌──────────────────┐    LLM Task     ┌──────────────────┐          │
│  │  OutboxPoller     │ ──────────────► │  twitter-post-   │          │
│  │  (cron: */2 min)  │   via TaskEngine│  tweet MCP tool  │          │
│  └──────────────────┘                  └──────────────────┘          │
│                                              │                       │
│                                              ▼                       │
│                                     Post Live on Platform            │
└─────────────────────────────────────────────────────────────────────┘
                                              │
                                    Users comment on post
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       COMMENT INGESTION                              │
│                                                                      │
│  Webhook (Twitter)                                                   │
│  ┌──────────────────┐                                                │
│  │ POST /api/social/ │ ──► Platform Adapter ──► SocialIngestion      │
│  │  webhooks/:plat   │        .parseWebhook()     .handleWebhook()   │
│  └──────────────────┘                                                │
│                                                                      │
│  Polling (YouTube, LinkedIn, Reddit)                                 │
│  ┌──────────────────┐                                                │
│  │ setInterval       │ ──► adapter.poll(since) ──► SocialIngestion   │
│  │ (60-120s)         │                                               │
│  └──────────────────┘                                                │
│                                                                      │
│  Instagram & Facebook: fully wired via webhook adapters               │
│  (InstagramAdapter, FacebookAdapter — Meta Graph API format)          │
│      Pinterest: No comment system — N/A                              │
│                                              │                       │
│                   PostContextService.getPostContext() (enrichment)    │
│                                              │                       │
│                                              ▼                       │
│                                     emit("comment", enrichedComment) │
└─────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AUTOMATION ENGINE                               │
│                                                                      │
│  CommentRuleEngine.evaluate(comment)                                 │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ For each enabled rule on this platform:               │          │
│  │  1. Check post_ids scope                              │          │
│  │  2. Check max_triggers_total / per_user               │          │
│  │  3. Match keywords (case-insensitive, word boundary)  │          │
│  │  4. Fallback: regex match                             │          │
│  │  5. On match:                                         │          │
│  │     a. Reply to comment (AI or template)              │          │
│  │     b. Send DM (immediate or delayed)                 │          │
│  │     c. Auto-tag contact                               │          │
│  │     d. Log to automation_log                          │          │
│  │     e. Schedule follow-up sequences                   │          │
│  └───────────────────────────────────────────────────────┘          │
│                              │                                       │
│                              ▼                                       │
│  DmDispatcher.createDmSender() / createCommentReplier()              │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ LocalMcpServerManager.callTool(serverName, toolName)  │          │
│  │                                                       │          │
│  │ Platform DM Map:                                      │          │
│  │  twitter   → twitter_send_dm / twitter_post_tweet     │          │
│  │  youtube   → (no DM) / yt_reply_to_comment            │          │
│  │  linkedin  → linkedin_send_message / linkedin_reply_..│          │
│  │  reddit    → reddit_send_message / reddit_reply_...   │          │
│  │  instagram → send_dm / reply_to_comment               │          │
│  │  facebook  → fb_send_message / fb_reply_to_comment    │          │
│  └───────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AI BRAIN (DMs only)                             │
│                                                                      │
│  SocialBrain.process(message)                                        │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ 1. RAG knowledge search                               │          │
│  │ 2. LLM chat (with conversation history)               │          │
│  │ 3. Parse { reply, confidence, intent }                │          │
│  │ 4. High confidence → auto-reply via DmDispatcher      │          │
│  │ 5. Low confidence → escalate via HandoffManager       │          │
│  └───────────────────────────────────────────────────────┘          │
│                                                                      │
│  New features (ManyChat parity):                                     │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ 6. LeadCaptureService.extract() — emails/phones       │          │
│  │ 7. FollowUpScheduler.processPending() — timed DMs     │          │
│  │ 8. FollowerWelcomeService.handleNewFollower()          │          │
│  └───────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Creating Test Content (Posts)

You need live posts on each platform so people (or your test account) can comment on them. There are three approaches:

### Option A: Use the Outbox (Recommended)

Schedule a post via the Outbox UI at `/social` or via API:

```bash
# Schedule a Twitter post
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitter",
    "contentBody": "Testing Social Brain comment automation! Reply with \"pricing\" to see the magic ✨",
    "scheduledTime": "2026-03-16T12:00:00Z"
  }'

# Schedule a Reddit post
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "reddit",
    "contentBody": "Testing Social Brain automation on Reddit",
    "platformMetadata": {
      "subreddit": "test",
      "title": "Social Brain Test Post"
    },
    "scheduledTime": "2026-03-16T12:00:00Z"
  }'
```

The Outbox Poller (runs every 2 minutes) will claim and publish these via the `universal-publisher` LLM task, which calls the appropriate platform MCP tool (e.g., `twitter-post-tweet`, `reddit-submit-post`).

### Option B: Post Manually via MCP Tools

Use the chat interface to ask the AI to post:

> "Post a tweet saying: Testing Social Brain! Reply with pricing for a surprise"

Or call the MCP tool directly via the admin API:

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "twitter",
    "tool": "twitter_post_tweet",
    "args": {
      "text": "Testing Social Brain automation! Reply with \"pricing\" to get a DM 📬"
    }
  }'
```

### Option C: Post Manually on Platform

Just go to Twitter/Reddit/YouTube and create a post by hand. Note the post ID — you'll need it for `post_ids` scoping in automation rules.

### Record the Post IDs

After posting, note the post IDs:

```bash
# Get your recent tweets
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "twitter", "tool": "twitter_get_me", "args": {}}'

# Then get user tweets
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "twitter", "tool": "twitter_get_user_tweets", "args": {"user_id": "YOUR_USER_ID"}}'
```

---

## 4. Test Suite A: Comment-to-DM Automation

### A1. Setup: Create Automation Rule

```bash
# Create a keyword-triggered rule
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pricing Interest",
    "platform": "twitter",
    "dm_template": "Hey {{username}}! Thanks for asking about pricing. Our Pro Plan starts at $49/month. Check it out: {{post_url}}",
    "comment_reply_template": "Thanks {{username}}! Check your DMs 📬",
    "keywords": "[\"pricing\", \"price\", \"how much\", \"cost\"]",
    "max_triggers_per_user": 2,
    "auto_tag": "lead"
  }'
```

Save the returned rule `id`.

### A2. Test: Keyword Match → DM + Comment Reply

**Steps:**
1. From a **different account** (or second browser), reply to your test post with: *"What's the pricing?"*
2. Wait for ingestion (webhook = instant, polling = up to 120s)
3. Verify:

```bash
# Check contacts — the commenter should appear
curl http://localhost:3000/api/social/contacts | python3 -m json.tool

# Check automation log — should show the trigger
curl http://localhost:3000/api/social/activity | python3 -m json.tool

# Check the rule's trigger count incremented
curl http://localhost:3000/api/social/rules | python3 -m json.tool
```

**Expected:**
- [ ] Contact created with `platform=twitter`, correct `username`
- [ ] Contact auto-tagged with `lead`
- [ ] Automation log shows `dm_sent=1`, `comment_replied=1`
- [ ] The commenter received a DM with pricing info
- [ ] A reply appeared on the comment: "Thanks @username! Check your DMs 📬"

### A3. Test: Per-User Trigger Limit

**Steps:**
1. Same user comments again with *"What does it cost?"*
2. Should trigger again (limit is 2)
3. Third comment with pricing keyword → should NOT trigger

**Expected:**
- [ ] First two comments trigger the rule
- [ ] Third comment does not trigger (per-user limit reached)
- [ ] Only 2 DMs sent to that user

### A4. Test: No-Match Comment

**Steps:**
1. Comment with *"Nice post!"* (no keywords match)

**Expected:**
- [ ] No DM sent
- [ ] No comment reply
- [ ] Automation log has no new entry for that comment

### A5. Test: Regex Fallback

```bash
# Create a rule with regex
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Email Collector",
    "platform": "twitter",
    "dm_template": "Thanks {{username}}! We will reach out to you at your email.",
    "keywords": "[]",
    "regex": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    "auto_tag": "email-shared"
  }'
```

**Steps:**
1. Comment: *"Interested! Reach me at test@example.com"*
2. Verify rule triggers on the email regex match

### A6. Test: Post-Scoped Rule

```bash
# Create a rule scoped to a specific post
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Launch Post Only",
    "platform": "twitter",
    "dm_template": "Thanks for the launch interest {{username}}!",
    "keywords": "[\"interested\", \"want\"]",
    "post_ids": "[\"YOUR_SPECIFIC_POST_ID\"]"
  }'
```

**Expected:**
- [ ] Comments on the specified post trigger the rule
- [ ] Comments on other posts do NOT trigger the rule

### A7. Test: Disabled Rule

```bash
curl -X PATCH http://localhost:3000/api/social/rules/RULE_ID \
  -H "Content-Type: application/json" \
  -d '{"enabled": 0}'
```

**Expected:**
- [ ] Comments matching keywords do NOT trigger
- [ ] Re-enable with `{"enabled": 1}` → triggers resume

---

## 5. Test Suite B: AI-Powered Comment Replies

### B1. Setup: Create AI-Reply Rule

```bash
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI Product Expert",
    "platform": "twitter",
    "dm_template": "Hey {{username}}, check your comment — I replied there!",
    "comment_reply_template": null,
    "keywords": "[\"question\", \"help\", \"support\"]",
    "use_ai_reply": 1,
    "ai_reply_context": "We sell a SaaS project management tool called TaskFlow. Plans: Starter $19/mo, Pro $49/mo, Enterprise custom. Free 14-day trial. Key features: Kanban boards, Gantt charts, time tracking, team collaboration."
  }'
```

### B2. Test: AI Generates Contextual Reply

**Steps:**
1. Comment: *"Quick question — does TaskFlow have Gantt chart support?"*
2. Wait for processing

**Expected:**
- [ ] Comment reply is AI-generated (mentions Gantt charts, context-aware)
- [ ] Reply is **not** from a template (no `{{username}}` placeholder visible)
- [ ] Reply tone is friendly and on-brand
- [ ] DM also sent with follow-up

### B3. Test: AI Fallback to Template

If `generateAiReply` is not configured (no AI wrapper connected), the engine falls back to `comment_reply_template`. Since we set it to `null`, no comment reply should be made but the DM should still go through.

**Expected:**
- [ ] If AI available: AI-generated comment reply
- [ ] If AI unavailable: No comment reply, DM still sent

---

## 6. Test Suite C: Follow-Up Sequences

### C1. Setup: Create Follow-Up Steps

```bash
# First, get your rule ID
RULE_ID=$(curl -s http://localhost:3000/api/social/rules | python3 -c "import json,sys; rules=json.load(sys.stdin)['rules']; print(rules[0]['id'])")

# Add follow-up step 1: 1 hour after trigger
curl -X POST "http://localhost:3000/api/social/rules/$RULE_ID/follow-ups" \
  -H "Content-Type: application/json" \
  -d '{
    "stepOrder": 0,
    "delaySeconds": 3600,
    "messageTemplate": "Hey {{username}}, just following up — did you get a chance to check out our pricing? Happy to answer any questions!"
  }'

# Add follow-up step 2: 24 hours after trigger
curl -X POST "http://localhost:3000/api/social/rules/$RULE_ID/follow-ups" \
  -H "Content-Type: application/json" \
  -d '{
    "stepOrder": 1,
    "delaySeconds": 86400,
    "messageTemplate": "Hi {{username}}, final reminder — our 14-day free trial ends soon. Start today: https://taskflow.example.com/trial"
  }'
```

### C2. Verify Follow-Up Steps

```bash
curl "http://localhost:3000/api/social/rules/$RULE_ID/follow-ups" | python3 -m json.tool
```

**Expected:**
- [ ] Two steps listed, ordered by `step_order`
- [ ] Correct `delay_seconds` and `message_template`

### C3. Test: Follow-Up Scheduled on Rule Trigger

**Steps:**
1. Trigger a comment that matches the rule
2. Check the follow-up jobs:

```bash
# Check the database for scheduled follow-ups (via admin or direct query)
curl http://localhost:3000/api/social/contacts | python3 -m json.tool
```

**Expected:**
- [ ] Follow-up jobs created for the triggered contact
- [ ] Jobs have `scheduled_at` timestamps matching `now + delaySeconds`
- [ ] Jobs are in pending state (not yet sent)

### C4. Test: Follow-Up Delivery

For testing, create a follow-up with a very short delay (e.g., 60 seconds):

```bash
curl -X POST "http://localhost:3000/api/social/rules/$RULE_ID/follow-ups" \
  -H "Content-Type: application/json" \
  -d '{
    "stepOrder": 2,
    "delaySeconds": 60,
    "messageTemplate": "Quick test follow-up for {{username}}!"
  }'
```

**Expected (after 60s):**
- [ ] The FollowUpScheduler processes the pending job
- [ ] DM sent to the contact
- [ ] Job marked as `sent` with `sent_at` timestamp

### C5. Test: Delete Follow-Up Step

```bash
STEP_ID="..." # from the GET response
curl -X DELETE "http://localhost:3000/api/social/rules/$RULE_ID/follow-ups/$STEP_ID"
```

**Expected:**
- [ ] Step deleted
- [ ] Future triggers don't schedule that step

---

## 7. Test Suite D: Lead Capture

### D1. Test: Email Extraction from DM

**Steps:**
1. Send a DM to the test account with a message containing an email:
   *"Sure! My email is testlead@example.com"*
2. Wait for the DM to be ingested (webhook or polling)

**Expected:**
- [ ] LeadCaptureService extracts `testlead@example.com`
- [ ] Contact updated with `email` field
- [ ] Contact auto-tagged with `lead`
- [ ] `lead_captured_at` timestamp set

### D2. Test: Phone Number Extraction

**Steps:**
1. DM: *"Call me at +1-555-867-5309"*

**Expected:**
- [ ] Phone number extracted: `+1-555-867-5309`
- [ ] Contact updated with `phone` field

### D3. Test: Both Email and Phone

**Steps:**
1. DM: *"Email me at alice@test.org or call 555-123-4567"*

**Expected:**
- [ ] Both `email` and `phone` captured

### D4. Verify via Leads API

```bash
curl http://localhost:3000/api/social/leads | python3 -m json.tool
curl "http://localhost:3000/api/social/leads?platform=twitter" | python3 -m json.tool
```

**Expected:**
- [ ] Leads listed with email, phone, platform, captured timestamp
- [ ] Platform filter works correctly

---

## 8. Test Suite E: Conversation Analytics

### E1. Test: Analytics After Activity

After running Test Suites A-D, check analytics:

```bash
# All-time analytics
curl http://localhost:3000/api/social/analytics | python3 -m json.tool

# Analytics since a specific date
curl "http://localhost:3000/api/social/analytics?since=2026-03-16T00:00:00Z" | python3 -m json.tool
```

**Expected:**
- [ ] Per-platform breakdown: `total_conversations`, `total_messages_in`, `total_messages_out`
- [ ] `auto_reply_rate` reflects the proportion of auto-replied messages
- [ ] `leads_captured` matches the number from Test Suite D
- [ ] `escalation_rate` reflects any handoff escalations

### E2. Verify Stats Endpoint

```bash
curl http://localhost:3000/api/social/stats | python3 -m json.tool
```

**Expected:**
- [ ] `totalContacts` matches number of unique commenters/DMers
- [ ] `totalMessages` includes both inbound and outbound
- [ ] `connections` array shows all configured platforms with correct `connected` status

---

## 9. Test Suite F: Follower Welcome DMs

### F1. Setup: Enable Follower Welcome

The FollowerWelcomeService needs configuration:

```typescript
// In socialBrain config:
{
  followerWelcome: {
    enabled: true,
    messages: {
      twitter: "Welcome to the community, {{username}}! 🎉 Ask me anything about TaskFlow.",
      reddit: "Thanks for the follow, {{username}}! Check out our wiki for getting started."
    },
    delaySeconds: 5
  }
}
```

### F2. Test: New Follower Triggers Welcome DM

**Steps:**
1. From a test account, follow the configured account
2. Wait for the follower event to be ingested

**Expected:**
- [ ] Welcome DM sent to the new follower
- [ ] DM contains interpolated `{{username}}`
- [ ] `welcome_sent` event emitted

### F3. Test: Duplicate Prevention

**Steps:**
1. Unfollow and re-follow the account

**Expected:**
- [ ] No second welcome DM sent (dedup by platform+userId)

### F4. Test: Platform Without Message

**Steps:**
1. New follower on a platform not configured in `messages` (e.g., TikTok)

**Expected:**
- [ ] No DM sent
- [ ] No error logged

---

## 10. Test Suite G: Human Handoff & Escalation

### G1. Test: Low-Confidence DM → Escalation

**Steps:**
1. Send a complex DM that the AI brain can't confidently answer:
   *"I need to cancel my subscription but I was charged twice and the payment gateway shows a different amount than what I agreed to"*
2. Wait for brain processing

**Expected:**
- [ ] Brain returns `confidence: "low"`
- [ ] HandoffManager creates a thread in Discord/Telegram
- [ ] Contact tagged with `handoff-active`
- [ ] CRM shows `handoff_active = 1`

### G2. Test: Human Agent Reply

**Steps:**
1. Reply in the Discord/Telegram handoff thread
2. Verify the reply is forwarded back to the contact

**Expected:**
- [ ] Reply sent to the original platform (Twitter/Reddit/etc.)
- [ ] Outbound message logged in CRM

### G3. Test: Close Handoff

```bash
CONTACT_ID="..."
curl -X POST "http://localhost:3000/api/social/handoff/$CONTACT_ID/close" \
  -H "Content-Type: application/json" \
  -d '{"resolution": "Refund processed, subscription cancelled"}'
```

**Expected:**
- [ ] `handoff_active` set to 0
- [ ] `handoff-active` tag removed
- [ ] Resolution logged

---

## 11. Test Suite H: Multi-Platform Verification

### H1. Twitter End-to-End

| Ingestion | DM Tool | Reply Tool | PostContext |
|-----------|---------|------------|------------|
| Webhook (Account Activity API) | `twitter_send_dm` | `twitter_post_tweet` (with `reply_to`) | `TwitterApiClient` (API v2) |

**Test:** Post tweet → comment from test account → verify DM + reply

### H2. Reddit End-to-End

| Ingestion | DM Tool | Reply Tool | PostContext |
|-----------|---------|------------|------------|
| Polling (`reddit_get_inbox`) | `reddit_send_message` | `reddit_reply_to_comment` | `RedditApiClient` (via MCP) |

**Test:** Post to r/test → comment with keyword → verify DM + reply

**Reddit-specific notes:**
- Polling interval: configurable, default 120s
- DM = Reddit private message (has `subject` field)
- Reply uses `thing_id` format: `t1_commentid`

### H3. YouTube End-to-End

| Ingestion | DM Tool | Reply Tool | PostContext |
|-----------|---------|------------|------------|
| Polling (YouTube Data API v3) | **None** (no DM API) | `yt_reply_to_comment` | `YouTubeApiClient` |

**Test:** Upload unlisted video → comment with keyword → verify comment reply (no DM)

**YouTube-specific notes:**
- YouTube has NO DM API — only comment replies work
- Upload via `yt_upload_video` tool (resumable upload, 10MiB chunks)
- Comment reply requires OAuth scope `youtube.force-ssl`

### H4. LinkedIn End-to-End

| Ingestion | DM Tool | Reply Tool | PostContext |
|-----------|---------|------------|------------|
| Polling | `linkedin_send_message` (partner API only) | `linkedin_reply_to_comment` | `LinkedInApiClient` |

**Test:** Create LinkedIn post → comment → verify comment reply

**LinkedIn-specific notes:**
- DMs require LinkedIn Marketing Partner status (most apps won't have this)
- Comment replies work with standard API access
- Uses URN format: `urn:li:comment:123`

### H5. Instagram End-to-End (Outbox + Manual MCP Tools)

> **Note:** Instagram is NOT wired into Social Brain's automation pipeline (no adapter in `SocialPlatform`, no `PLATFORM_DM_MAP` entry). These tests verify the MCP tools work directly.

| Outbox Publishing | DM Tool | Reply Tool | Comments Tool | Insights Tool |
|-----------|---------|------------|------------|----------|
| `publish_media` | `send_dm` (24h window) | `reply_to_comment` | `get_media_comments` | `get_media_insights` |

**Available MCP Tools (12 total):**
- `get_profile_info`, `get_media_posts`, `get_media_insights`, `publish_media`
- `get_account_pages`, `get_account_insights`, `validate_access_token`
- `get_conversations`, `get_conversation_messages`, `send_dm`
- `reply_to_comment`, `get_media_comments`

#### H5a. Test: Instagram Token Validation

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "instagram", "tool": "validate_access_token", "args": {}}'
```

**Expected:**
- [ ] Returns token validity, permissions list, expiry info
- [ ] If expired/invalid, shows clear error

#### H5b. Test: Publish Instagram Post via Outbox

```bash
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "instagram",
    "contentBody": "Testing Social Brain automation! 📸 #test",
    "platformMetadata": {
      "image_url": "https://picsum.photos/1080/1080"
    },
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'
```

**Expected:**
- [ ] Outbox item created with `platform: "instagram"`
- [ ] Poller claims and submits to TaskEngine
- [ ] LLM agent calls `publish_media` tool
- [ ] Post appears on Instagram

#### H5c. Test: Publish via Direct MCP Call

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "instagram",
    "tool": "publish_media",
    "args": {
      "image_url": "https://picsum.photos/1080/1080",
      "caption": "Direct MCP test post #openzigs"
    }
  }'
```

#### H5d. Test: Read Comments on a Post

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "instagram", "tool": "get_media_comments", "args": {"media_id": "MEDIA_ID"}}'
```

#### H5e. Test: Reply to Comment via MCP

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "instagram",
    "tool": "reply_to_comment",
    "args": {"comment_id": "COMMENT_ID", "message": "Thanks for commenting! 🙌"}
  }'
```

#### H5f. Test: Send Instagram DM via MCP

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "instagram",
    "tool": "send_dm",
    "args": {"recipient_id": "IG_USER_ID", "message": "Hello from Social Brain test!"}
  }'
```

**IG DM constraints:**
- Recipient must have messaged the Page/Business first (24-hour window)
- Requires `instagram_manage_messages` permission

#### H5g. Test: Account & Post Insights

```bash
# Account-level analytics
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "instagram", "tool": "get_account_insights", "args": {}}'

# Post-level insights
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "instagram", "tool": "get_media_insights", "args": {"media_id": "MEDIA_ID"}}'
```

### H6. Facebook End-to-End (Outbox + Manual MCP Tools)

> **Note:** Facebook is fully wired into Social Brain's automation pipeline. Webhook-based comment ingestion (`FacebookAdapter`) and DM/reply dispatch (`fb_send_message`, `fb_reply_to_comment`) are active. The tests below also cover direct MCP tool verification.

| Outbox Publishing | Messenger Tool | Reply Tool | Comments Tool | Insights Tool |
|-----------|---------|------------|------------|----------|
| `fb_publish_post` | `fb_send_message` (24h window) | `fb_reply_to_comment` | `fb_get_post_comments` | `fb_get_post_insights` |

**Available MCP Tools (10 total):**
- `fb_get_page_info`, `fb_get_page_posts`, `fb_get_post_insights`, `fb_publish_post`
- `fb_get_conversations`, `fb_get_conversation_messages`, `fb_send_message`
- `fb_get_page_insights`, `fb_get_post_comments`, `fb_reply_to_comment`

#### H6a. Test: Facebook Page Info

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "facebook", "tool": "fb_get_page_info", "args": {}}'
```

**Expected:**
- [ ] Returns Page name, followers, category, verification status
- [ ] Confirms `FACEBOOK_PAGE_TOKEN` is valid

#### H6b. Test: Publish Facebook Post via Outbox

```bash
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "facebook",
    "contentBody": "Testing Social Brain automation on Facebook! 🧪",
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'
```

**Expected:**
- [ ] Outbox item created, poller publishes via `fb_publish_post`
- [ ] Post appears on the Facebook Page

#### H6c. Test: Publish via Direct MCP Call

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "facebook",
    "tool": "fb_publish_post",
    "args": {"message": "Direct MCP test post from OpenZigs"}
  }'
```

#### H6d. Test: Read Comments on a Post

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "facebook", "tool": "fb_get_post_comments", "args": {"post_id": "POST_ID"}}'
```

#### H6e. Test: Reply to Comment via MCP

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "facebook",
    "tool": "fb_reply_to_comment",
    "args": {"comment_id": "COMMENT_ID", "message": "Thanks for the feedback!"}
  }'
```

#### H6f. Test: Send Messenger Message via MCP

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "facebook",
    "tool": "fb_send_message",
    "args": {"recipient_id": "PSID_OR_USER_ID", "message": "Hello from Social Brain!"}
  }'
```

**FB Messenger constraints:**
- Uses Page-Scoped IDs (PSID), not regular Facebook user IDs
- 24-hour messaging window (user must have messaged the Page first)
- Requires `pages_messaging` permission

#### H6g. Test: Page & Post Insights

```bash
# Page-level analytics
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "facebook", "tool": "fb_get_page_insights", "args": {}}'

# Post-level insights
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "facebook", "tool": "fb_get_post_insights", "args": {"post_id": "POST_ID"}}'
```

### H7. Pinterest End-to-End (Outbox + Analytics)

> **Note:** Pinterest is a **publishing and analytics platform** — it has no native DM API, no comment system on pins, and no webhook/polling ingestion. Social Brain automation (rules, DMs, replies) does not apply. Testing focuses on publishing and SEO analytics.

| Outbox Publishing | Board Management | Analytics | SEO Tools |
|-----------|---------|------------|----------|
| `pinterest-create-pin` | `pinterest-list-boards` | `pinterest-analytics`, `pinterest-pin-insights` | `pinterest-trends`, `pinterest-keyword-metrics`, `pinterest-seo-analyze` |

**Available MCP Tools (10 total):**
- `pinterest-list-boards`, `pinterest-create-pin`, `pinterest-pin-insights`
- `pinterest-analytics`, `pinterest-trends`, `pinterest-keyword-metrics`
- `pinterest-seo-analyze`, `pinterest-search-pins`, `pinterest-content-ideas`, `pinterest-related-keywords`

#### H7a. Test: List Boards

This is a critical prerequisite for pin creation:

```bash
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-list-boards", "args": {}}'
```

**Expected:**
- [ ] Returns array of boards with IDs, names, descriptions
- [ ] At least one board exists (needed for pin creation)

#### H7b. Test: Publish Pin via Outbox

```bash
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "pinterest",
    "contentBody": "Amazing test pin for Social Brain! #automation #testing",
    "platformMetadata": {
      "image_url": "https://picsum.photos/1000/1500",
      "link": "https://example.com",
      "title": "Social Brain Test Pin"
    },
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'
```

**⚠️ Important:** The outbox LLM agent will call `pinterest-list-boards` FIRST to get a valid board ID, then `pinterest-create-pin`. The agent is explicitly instructed to ignore board names from the prompt and only use real board IDs.

#### H7c. Test: Create Pin via Direct MCP Call

```bash
# First, get board IDs
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-list-boards", "args": {}}'

# Then create pin
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "pinterest",
    "tool": "pinterest-create-pin",
    "args": {
      "board_id": "BOARD_ID_FROM_ABOVE",
      "title": "Test Pin",
      "description": "Testing pin creation via MCP #test",
      "image_url": "https://picsum.photos/1000/1500",
      "link": "https://example.com"
    }
  }'
```

#### H7d. Test: Pinterest Analytics & SEO

```bash
# Account analytics
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-analytics", "args": {"report_type": "summary"}}'

# Trending keywords
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-trends", "args": {"region": "US"}}'

# Keyword research
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-keyword-metrics", "args": {"keywords": ["home decor", "diy projects"]}}'

# SEO analysis on a pin
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-seo-analyze", "args": {"pin_id": "PIN_ID"}}'
```

#### H7e. Test: Pinterest Reports API

```bash
# Check Pinterest connection status
curl http://localhost:3000/api/pinterest/status | python3 -m json.tool

# List boards via reports API
curl http://localhost:3000/api/pinterest/boards | python3 -m json.tool

# List saved reports
curl http://localhost:3000/api/pinterest/reports | python3 -m json.tool
```

### H8. Cross-Platform Isolation

**Test:** Same username on different platforms should create separate contacts.

**Steps:**
1. Comment on Twitter as `testuser`
2. Comment on Reddit as `testuser`
3. Verify two separate contacts exist

**Expected:**
- [ ] Two contacts: `(twitter, testuser)` and `(reddit, testuser)`
- [ ] No message cross-contamination
- [ ] Analytics show separate platform counts

---

## 12. Simulated Testing (No Real Accounts)

If you don't have real platform credentials, use curl to simulate webhook payloads:

### Simulate Twitter Comment

```bash
curl -X POST http://localhost:3000/api/social/webhooks/twitter \
  -H "Content-Type: application/json" \
  -d '{
    "for_user_id": "12345",
    "tweet_create_events": [{
      "id_str": "tweet_sim_001",
      "text": "@testbrand What is your pricing?",
      "user": {"id_str": "sim_user_001", "screen_name": "simulated_user"},
      "in_reply_to_status_id_str": "original_post_001",
      "created_at": "Mon Mar 16 12:00:00 +0000 2026"
    }]
  }'
```

### Simulate Instagram Comment

> **Note:** Instagram webhooks are fully wired into Social Brain. This payload will be processed by `InstagramAdapter`, parsed into a `SocialMessage`, and evaluated by the comment rule engine. Requires `INSTAGRAM_ACCESS_TOKEN` env var.

```bash
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "id": "17841400000000000",
      "time": 1742140800,
      "changes": [{
        "field": "comments",
        "value": {
          "id": "ig_comment_001",
          "text": "How much does this cost?",
          "from": {"id": "ig_user_001", "username": "ig_test_user"},
          "media": {"id": "ig_post_001"}
        }
      }]
    }]
  }'
```

### Simulate Facebook Comment

> **Note:** Facebook webhooks are fully wired into Social Brain. This payload will be processed by `FacebookAdapter`, parsed into a `SocialMessage`, and evaluated by the comment rule engine. Requires `FACEBOOK_PAGE_TOKEN` env var.

```bash
curl -X POST http://localhost:3000/api/social/webhooks/facebook \
  -H "Content-Type: application/json" \
  -d '{
    "object": "page",
    "entry": [{
      "id": "FB_PAGE_001",
      "time": 1742140800,
      "changes": [{
        "field": "feed",
        "value": {
          "item": "comment",
          "comment_id": "fb_comment_001",
          "post_id": "fb_post_001",
          "message": "Interested in pricing!",
          "from": {"id": "fb_user_001", "name": "FB Test User"},
          "created_time": 1742140800
        }
      }]
    }]
  }'
```

### Simulate Instagram DM

> **Note:** Instagram DM webhooks are fully wired into Social Brain. This payload will be processed by `InstagramAdapter` (parses `entry[].messaging[]` array), creating a `SocialMessage` of type `dm`. Requires `INSTAGRAM_ACCESS_TOKEN` env var.

```bash
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "id": "17841400000000000",
      "time": 1742140800,
      "messaging": [{
        "sender": {"id": "ig_user_001"},
        "recipient": {"id": "17841400000000000"},
        "timestamp": 1742140800000,
        "message": {
          "mid": "dm_001",
          "text": "Hi! My email is test@example.com and my phone is 555-123-4567"
        }
      }]
    }]
  }'
```

### Verify Simulated Results

```bash
# Contacts should now exist
curl http://localhost:3000/api/social/contacts | python3 -m json.tool

# Activity log should show triggers
curl http://localhost:3000/api/social/activity | python3 -m json.tool

# Analytics should reflect the activity
curl http://localhost:3000/api/social/analytics | python3 -m json.tool

# Leads should show captured email/phone
curl http://localhost:3000/api/social/leads | python3 -m json.tool
```

**Note:** Simulated webhooks will create contacts and trigger rules, but DM/reply dispatch will fail (no real MCP server connection). Check the logs for `[DmDispatcher]` errors — this is expected in simulation mode. The important thing is the pipeline works up to the dispatch point.

---

## 13. Outbox Integration: How Posting Works

### Posting Flow

```
UI/API → OutboxRepository.enqueue() → outbox_queue table (status: pending)
    ↓ (cron: every 2 minutes)
OutboxPoller.claimPending() → sets status: processing
    ↓
TaskEngine.submit() → Creates background task with skill: "universal-publisher"
    ↓
LLM Agent → Picks appropriate MCP tool based on platform
    ↓
MCP Tool Call (e.g., twitter_post_tweet, reddit_submit_post)
    ↓
Success → update-outbox-status tool → status: published
Failure → status: failed (with error message)
```

### Platform Tools Used by Outbox

| Platform | MCP Tool | MCP Server |
|----------|----------|------------|
| Twitter | `twitter-post-tweet` or `twitter_post_tweet` | `twitter` (external/twitter-mcp) |
| Reddit | `reddit-submit-post` or `reddit_submit_post` | `reddit` (external/reddit-mcp) |
| YouTube | `youtube-upload-video` or `yt_upload_video` | `youtube` (external/youtube-mcp) |
| LinkedIn | `linkedin-create-post` or `linkedin_create_post` | `linkedin` (external/linkedin-mcp) |
| Pinterest | `pinterest-create-pin` | Built-in (direct API, `PINTEREST_ACCESS_TOKEN`) |
| Facebook | `fb_publish_post` | `facebook` (external/fb-mcp, Python) |
| Instagram | `publish_media` | `instagram` (external/ig-mcp, Python) |

### Instagram & Facebook Outbox Notes

**Instagram (`publish_media`):**
- Requires a public `image_url` (Instagram fetches it server-side)
- Caption supports hashtags and mentions
- Video: must be `.mp4`, 3-60s for Reels
- API version: v19.0 (configurable)
- Rate limit: ~25 posts/day, 200 API requests/hour

**Facebook (`fb_publish_post`):**
- Text-only posts: just `message` field
- Link posts: include `link` in the body — Facebook auto-generates preview
- Photo posts: requires `photo_url` in metadata
- API version: v24.0

**Pinterest (`pinterest-create-pin`):**
- **Must call `pinterest-list-boards` FIRST** — the LLM agent is instructed to do this automatically
- Supports `image_url` or `image_path` (base64 upload)
- Pin dimensions: 1000x1500px recommended (2:3 ratio)
- `board_id` is required — cannot create pins without a board

### Test: Outbox → Post → Comment → Automation

This is the full lifecycle test:

1. **Schedule a post** via Outbox API
2. **Wait for Outbox Poller** to publish it (check `/api/outbox/queue`)
3. **Comment on the published post** from a test account
4. **Wait for ingestion** (webhook or polling)
5. **Verify automation triggered** (CRM, activity, DM/reply)

```bash
# Step 1: Schedule
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitter",
    "contentBody": "🚀 Big announcement! Reply with interested for early access.",
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'

# Step 2: Watch the queue
watch -n 5 'curl -s http://localhost:3000/api/outbox/queue?status=processing | python3 -m json.tool'

# Step 3: After published, note the tweet ID from the task output
# Step 4: Comment from test account
# Step 5: Verify
curl http://localhost:3000/api/social/activity | python3 -m json.tool
```

### Test: Outbox Publish to All Platforms

Verify that the outbox can publish to every supported platform:

```bash
# Instagram
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "instagram",
    "contentBody": "Outbox → Instagram test 📷 #openzigs",
    "platformMetadata": {"image_url": "https://picsum.photos/1080/1080"},
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'

# Facebook
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "facebook",
    "contentBody": "Outbox → Facebook test 📘",
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'

# Pinterest
curl -X POST http://localhost:3000/api/outbox/queue \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "pinterest",
    "contentBody": "Outbox → Pinterest test pin",
    "platformMetadata": {
      "image_url": "https://picsum.photos/1000/1500",
      "title": "Test Pin",
      "link": "https://example.com"
    },
    "scheduledTime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'
```

**Expected per platform:**
- [ ] Instagram: Post/Reel published to business account
- [ ] Facebook: Post published to Page
- [ ] Pinterest: Pin created on a board (LLM picks board via `pinterest-list-boards`)
- [ ] All outbox items transition: `pending` → `processing` → `published`

---

## 14. Platform Integration Status

All seven platforms have full MCP tool support. Instagram and Facebook are **fully integrated** into the Social Brain automation pipeline as of this version.

### Current State: Full Platform Coverage

| Capability | Twitter | Reddit | YouTube | LinkedIn | Instagram | Facebook | Pinterest |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Publish via Outbox | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Publish via MCP tool | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read comments via MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A |
| Reply to comments via MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A |
| Send DM via MCP | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | N/A |
| **Automated** comment ingestion | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A |
| **Automated** DM/reply on trigger | ✅ | ✅ | ✅ (reply only) | ✅ | ✅ | ✅ | N/A |
| Comment rule engine | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A |
| Analytics via MCP | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |

### Instagram Integration Details

**Files:** `src/channels/social/social-ingestion.ts` (`InstagramAdapter`), `src/channels/social/platform-api-client.ts` (`InstagramApiClient`)

- **Comment ingestion:** Webhook via `POST /api/social/webhooks/instagram` — parses `entry[].changes[{field:"comments"}]`
- **DM ingestion:** Same webhook endpoint — parses `entry[].messaging[]` array
- **DM dispatch:** `send_dm` tool on the `instagram` MCP server — args: `{ recipient_id, message }` (IGSID)
- **Reply dispatch:** `reply_to_comment` tool — args: `{ comment_id, message }`
- **Post context enrichment:** `InstagramApiClient` calls `https://graph.instagram.com/v19.0/{postId}`
- **Env var required:** `INSTAGRAM_ACCESS_TOKEN`
- **Note:** Instagram DMs have a 24-hour window restriction (user must message first)

### Facebook Integration Details

**Files:** `src/channels/social/social-ingestion.ts` (`FacebookAdapter`), `src/channels/social/platform-api-client.ts` (`FacebookApiClient`)

- **Comment ingestion:** Webhook via `POST /api/social/webhooks/facebook` — parses `entry[].changes[{field:"feed", value.item:"comment"}]`
- **DM ingestion:** Same webhook endpoint — parses `entry[].messaging[]` array (Messenger)
- **DM dispatch:** `fb_send_message` tool on the `facebook` MCP server — args: `{ recipient_id, message }` (PSID)
- **Reply dispatch:** `fb_reply_to_comment` tool — args: `{ comment_id, message }`
- **Post context enrichment:** `FacebookApiClient` calls `https://graph.facebook.com/v19.0/{postId}`
- **Env var required:** `FACEBOOK_PAGE_TOKEN`
- **Note:** Facebook Messenger uses Page-Scoped IDs (PSIDs); 24-hour messaging window applies

### Pinterest Integration Note

Pinterest pins have no native comment thread or DM API. This is a platform limitation, not a code gap. Pinterest integration is correctly scoped to publishing and SEO analytics.

### What This Means for Testing

- **Test Suites A-G** (automation, AI replies, follow-ups, lead capture, etc.) work with **all six social platforms** (Twitter, Reddit, YouTube, LinkedIn, Instagram, Facebook)
- **Test Suite H** covers platform-specific MCP tool verification for all platforms including Instagram, Facebook, and Pinterest
- **Outbox publishing** works for ALL 7 platforms

---

## 15. Verification Checklist

### Core Pipeline

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | Server healthy | `curl localhost:3000/health` | `{"status":"ok"}` |
| 2 | MCP servers running | `curl localhost:3000/api/admin/mcp/local-servers` | Social servers listed |
| 3 | Social Brain enabled | `curl localhost:3000/api/social/config` | `enabled: true` |
| 4 | Platform connected | `curl localhost:3000/api/social/connections` | At least one `connected: true` |
| 5 | Rules exist | `curl localhost:3000/api/social/rules` | Non-empty rules array |
| 6 | Webhook accepts payload | POST simulated comment | `{"received": true}` |
| 7 | Contact created | `curl localhost:3000/api/social/contacts` | New contact in list |
| 8 | Rule triggered | `curl localhost:3000/api/social/activity` | Automation log entry |
| 9 | DM dispatched | Check platform inbox | DM received |
| 10 | Comment replied | Check post comments | Reply visible |

### ManyChat-Parity Features

| # | Feature | API Endpoint | What to Verify |
|---|---------|-------------|----------------|
| 11 | AI comment reply | Rule with `use_ai_reply: 1` | AI-generated reply on comment |
| 12 | Follow-up steps created | `GET /rules/:id/follow-ups` | Steps listed |
| 13 | Follow-up scheduled | Trigger a rule | Jobs created in DB |
| 14 | Follow-up sent | Wait for `delaySeconds` | DM sent, job marked sent |
| 15 | Lead email captured | DM with email address | `GET /leads` shows email |
| 16 | Lead phone captured | DM with phone number | `GET /leads` shows phone |
| 17 | Analytics populated | Activity generates data | `GET /analytics` shows stats |
| 18 | Follower welcome | New follower event | DM sent, dedup works |

### Instagram / Facebook / Pinterest

| # | Check | Platform | Command | Expected |
|---|-------|----------|---------|----------|
| 19 | IG MCP server starts | Instagram | Check local-servers list | `instagram` server running |
| 20 | IG token valid | Instagram | Call `validate_access_token` | Permissions listed |
| 21 | IG publish via outbox | Instagram | Enqueue + wait | Post appears on IG |
| 22 | IG reply to comment | Instagram | Call `reply_to_comment` | Reply visible |
| 23 | IG send DM | Instagram | Call `send_dm` (24h window) | DM received |
| 24 | IG insights | Instagram | Call `get_media_insights` | Metrics returned |
| 25 | FB MCP server starts | Facebook | Check local-servers list | `facebook` server running |
| 26 | FB page info | Facebook | Call `fb_get_page_info` | Page details returned |
| 27 | FB publish via outbox | Facebook | Enqueue + wait | Post on Page |
| 28 | FB reply to comment | Facebook | Call `fb_reply_to_comment` | Reply visible |
| 29 | FB send message | Facebook | Call `fb_send_message` (24h) | Message received |
| 30 | FB page insights | Facebook | Call `fb_get_page_insights` | Analytics returned |
| 31 | Pinterest boards | Pinterest | Call `pinterest-list-boards` | Boards listed |
| 32 | Pinterest pin via outbox | Pinterest | Enqueue + wait | Pin created |
| 33 | Pinterest analytics | Pinterest | Call `pinterest-analytics` | Report returned |
| 34 | Pinterest SEO | Pinterest | Call `pinterest-seo-analyze` | Score/suggestions |

### Error Handling

| # | Scenario | Expected |
|---|----------|----------|
| 35 | MCP server not running | DM dispatch fails gracefully, error logged |
| 36 | Invalid webhook payload | 200 returned, no crash |
| 37 | Rule with max_triggers exceeded | Comment ignored silently |
| 38 | AI reply generation fails | Falls back to template or skips |
| 39 | Follow-up DM fails | Job marked as error, scheduler continues |
| 40 | IG token expired | `validate_access_token` returns error, publish fails with 401 |
| 41 | FB Page token expired | `fb_get_page_info` fails, publish fails with auth error |
| 42 | Pinterest board not found | `pinterest-create-pin` fails with descriptive error |

---

## 16. Troubleshooting

### Comments Not Being Detected

```bash
# Check if polling is active
curl http://localhost:3000/api/social/config | python3 -c "
import json, sys
c = json.load(sys.stdin)
for p, cfg in c.get('connections', {}).items():
    print(f'{p}: enabled={cfg.get(\"enabled\")}, mode={cfg.get(\"mode\")}')
"

# Check server logs for ingestion events
# Look for: [SocialIngestion] Processed comment|message

# Verify the webhook URL is registered with the platform
# Twitter: developer.x.com → App → Webhooks
# Instagram: developers.facebook.com → Webhooks → Instagram
```

### DMs Not Being Sent

```bash
# Check if the MCP server for that platform is running
curl http://localhost:3000/api/admin/mcp/local-servers | python3 -c "
import json, sys
servers = json.load(sys.stdin)
for s in servers:
    if s.get('category') == 'social':
        print(f'{s[\"name\"]}: {s[\"status\"]} ({len(s.get(\"tools\", []))} tools)')
"

# Common issues:
# - Missing env vars → server won't start
# - API rate limits → 429 errors in logs
# - OAuth tokens expired → 401 errors
```

### Instagram / Facebook MCP Server Won't Start

Both are Python-based servers (unlike the Node.js ones for Twitter/Reddit/etc.):

```bash
# Check if the Python venv exists
ls external/ig-mcp/.venv/bin/python
ls external/fb-mcp/.venv/bin/python

# If missing, create it:
cd external/ig-mcp && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd external/fb-mcp && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Check required env vars are set
echo "IG: INSTAGRAM_ACCESS_TOKEN=${INSTAGRAM_ACCESS_TOKEN:+set}"
echo "FB: FACEBOOK_PAGE_TOKEN=${FACEBOOK_PAGE_TOKEN:+set}"
echo "FB: FACEBOOK_APP_ID=${FACEBOOK_APP_ID:+set}"
```

### Pinterest Token Issues

```bash
# Pinterest uses a direct API token (no MCP subprocess)
# Verify token works:
curl -X POST http://localhost:3000/api/admin/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"server": "pinterest", "tool": "pinterest-list-boards", "args": {}}'

# If token expired, get new one at:
# https://developers.pinterest.com/tools/api-explorer/
```

### Rules Not Triggering

```bash
# Verify the rule is enabled and matches the platform
curl http://localhost:3000/api/social/rules | python3 -c "
import json, sys
rules = json.load(sys.stdin)['rules']
for r in rules:
    print(f'{r[\"name\"]}: platform={r[\"platform\"]}, enabled={r[\"enabled\"]}, triggers={r[\"trigger_count\"]}/{r.get(\"max_triggers_total\", \"∞\")}')
"

# Check if keywords match (case-insensitive, word-boundary)
# 'price' matches 'What is the price?' but NOT 'priceless'
```

### Follow-Ups Not Processing

The `FollowUpScheduler` runs on a timer. Check:
- Is the scheduler started? (look for `[FollowUpScheduler] Started` in logs)
- Are jobs in pending state with `scheduled_at` in the past?
- Is `sendDm` configured on the scheduler?

### Analytics Showing Zeros

Analytics are computed from the `social_messages` and `social_contacts` tables. If they show zeros:
- Verify messages are being inserted (check `GET /contacts/:id/messages`)
- Check the `since` parameter — it filters by message timestamp
- Ensure contacts have platform fields populated
