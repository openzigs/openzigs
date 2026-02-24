# Social Brain — Comprehensive Test Plan

> Feature: Social Brain (Issues #291, #299–#312)
> Owner: @mgcronin
> Last Updated: 2026-02-24

---

## Table of Contents

1. [Test Scope & Architecture Overview](#1-test-scope--architecture-overview)
2. [MCP Server Architecture (Native Transport)](#2-mcp-server-architecture-native-transport)
3. [Unit Tests](#3-unit-tests)
4. [Integration Tests](#4-integration-tests)
5. [End-to-End Tests](#5-end-to-end-tests)
6. [Manual Test Procedures](#6-manual-test-procedures)
7. [Performance & Load Testing](#7-performance--load-testing)
8. [Security Testing](#8-security-testing)
9. [Test Data & Fixtures](#9-test-data--fixtures)
10. [Coverage Matrix](#10-coverage-matrix)

---

## 1. Test Scope & Architecture Overview

### Components Under Test

| # | Component | File | Test Status |
|---|-----------|------|-------------|
| 1 | **SocialRepository** (CRM) | `src/channels/social/social-repository.ts` | ✅ `social-repository.test.ts` (19 tests) |
| 2 | **SocialIngestion** | `src/channels/social/social-ingestion.ts` | ✅ `social-ingestion.test.ts` (23 tests) |
| 3 | **SocialBrain** (AI Engine) | `src/channels/social/social-brain.ts` | ✅ `social-brain.test.ts` (13 tests) |
| 4 | **CommentRuleEngine** | `src/channels/social/comment-rule-engine.ts` | ✅ `comment-rule-engine.test.ts` (13 tests) |
| 5 | **PlatformApiClient** | `src/channels/social/platform-api-client.ts` | ✅ `platform-api-client.test.ts` (21 tests) |
| 6 | **HandoffManager** | `src/channels/social/handoff-manager.ts` | ✅ `handoff-manager.test.ts` (11 tests) |
| 7 | **DmDispatcher** | `src/channels/social/dm-dispatcher.ts` | ✅ `dm-dispatcher.test.ts` (16 tests) |
| 8 | **Types** | `src/channels/social/types.ts` | N/A (type-only) |
| 9 | **Admin API routes** | `src/api/admin.ts` (social endpoints) | ❌ Missing integration tests |
| 10 | **UI – Social Brain page** | `ui/app/admin/social-brain/page.tsx` | ❌ Missing |
| 11 | **UI – CRM panel** | `ui/components/social/` | ❌ Missing |

**Total unit tests passing:** 116 across 7 test files (as of 2026-02-24)

### Data Flow Under Test

```
Webhook POST / Polling
    → Platform Adapter (Instagram/Facebook/Twitter/YouTube/LinkedIn/Reddit)
        → SocialIngestionService.ingest()
            → SocialRepository.upsertContact()
            → SocialRepository.insertMessage()
            → PostContextService.enrichComment()   ← Direct HTTP (NOT MCP)
            → CommentRuleEngine.evaluate()
                ├── reply: replyToComment() ← DmDispatcher.createCommentReplier()
                └── dm: sendDm() ← DmDispatcher.createDmSender()
            → SocialBrain.process()
                → KnowledgeIngestionService.search()   ← Local RAG
                → CopilotWrapperService.chat()          ← LLM
                → emit("reply") → DmDispatcher.sendDm()
                → emit("escalate") → HandoffManager.escalate()
```

### Critical Architectural Point: MCP Independence

**Social Brain does NOT depend on any MCP servers for its core pipeline.** The architecture uses:

- **Direct webhook parsing** via platform adapters (no external dependency)
- **Direct HTTP** to platform Graph APIs via `PlatformApiClient` implementations (PostContextService)
- **Local RAG** via `KnowledgeIngestionService.search()` (SQLite + embeddings)
- **LLM generation** via `CopilotWrapperService.chat()` (ephemeral Copilot session)
- **Direct platform DM/reply dispatch** via `DmDispatcher` (calls native MCP server tool methods)

The native MCP servers (`external/ig-mcp/`, `external/fb-mcp/`, etc.) are for the **chat tool interface** — e.g., the user typing "list Instagram comments" in the chat window. They are also invoked by `DmDispatcher` to send DMs/replies via their tool methods.

---

## 2. MCP Server Architecture (Native Transport)

All MCP servers are now **native subprocess servers** (stdio transport, managed by `LocalMcpServerManager`). Docker sidecars have been fully removed.

### Current MCP Server Inventory

| Server | Directory | Transport | Tools | Status |
|--------|-----------|-----------|-------|--------|
| **Instagram** | `external/ig-mcp/` | stdio (Python) | 12 | ✅ Exists (DMs, comment reply, post context, analytics) |
| **Facebook** | `external/fb-mcp/` | stdio (Python) | 10 | ✅ Built (#301) — DMs, comment reply, page analytics |
| **Twitter/X** | `external/twitter-mcp/` | stdio (Python) | 8 | ✅ Built (#302) — DMs, tweet reply (via post_tweet), search |
| **YouTube** | `external/youtube-mcp/` | stdio (Python) | 7 | ✅ Built (#303) — Comment reply, video search, analytics |
| **LinkedIn** | `external/linkedin-mcp/` | stdio (Python) | 8 | ✅ Built (#304) — DMs (partner-only), comment reply, posts |
| **Reddit** | `external/reddit-mcp/` | stdio (Python) | 8 | ✅ Built (#305) — Messages, comment reply, search |
| **MarkItDown** | `uvx markitdown-mcp` | stdio (Python via uvx) | — | ✅ Native |
| **Gmail** | `npx @anthropic/mcp-server-gmail` | stdio (Node) | — | ✅ Native |
| **Database** | `jbang jdbc@quarkiverse/quarkus-mcp-servers` | stdio (JBang) | — | ✅ Native |
| **GitHub** | `npx @github/mcp-server` | stdio (Node) | — | ✅ Native |
| **Word/Office** | `uvx --from office-word-mcp-server word_mcp_server` | stdio (Python) | — | ✅ Native |
| **Calendar** | `npx @anthropic/mcp-server-google-calendar` | stdio (Node) | — | ✅ Native |

### What Removed (No Longer Present)

The following phantom Docker images were removed per issue #300/#312:

- ~~`ghcr.io/community/mcp-linkedin:latest`~~ — never existed at that registry
- ~~`ghcr.io/community/mcp-twitter:latest`~~ — never existed at that registry
- ~~`ghcr.io/community/facebook-mcp-server:latest`~~ — never existed at that registry
- ~~`ghcr.io/collactivelabs/pinterest-mcp-server:latest`~~ — no Docker package published
- All non-social Docker MCP sidecars (markitdown, gmail, database, github, word)

`docker-compose.yml` now only contains 3 services: `agent`, `tunnel`, `audio-sidecar`.

### MCP Server Test Coverage

| Server | Unit Tests | Notes |
|--------|-----------|-------|
| `external/ig-mcp/` | ✅ (Python, internal) | Instagram-specific |
| `external/fb-mcp/` | ❌ Missing | Need Python tests |
| `external/twitter-mcp/` | ❌ Missing | Need Python tests |
| `external/youtube-mcp/` | ❌ Missing | Need Python tests |
| `external/linkedin-mcp/` | ❌ Missing | Need Python tests |
| `external/reddit-mcp/` | ❌ Missing | Need Python tests |

### What Social Brain Needs Per Platform

For the **core pipeline** (comment → DM/reply automation):

| Platform | Core Pipeline | Post-Context | DM Dispatch | Comment Reply | MCP Tool Used |
|----------|--------------|--------------|-------------|---------------|---------------|
| Instagram | ✅ Webhook | ✅ `InstagramApiClient` | ✅ via `ig-mcp` | ✅ via `ig-mcp` | `send_dm` / `reply_to_comment` |
| Facebook | ✅ Webhook | ✅ `FacebookApiClient` | ✅ via `fb-mcp` | ✅ via `fb-mcp` | `fb_send_message` / `fb_reply_to_comment` |
| Twitter/X | ✅ Webhook | ✅ `TwitterApiClient` | ✅ via `twitter-mcp` | ✅ via `twitter-mcp` | `twitter_send_dm` / `twitter_post_tweet` (reply_to) |
| YouTube | ✅ Polling | ✅ `YouTubeApiClient` | ❌ No DM API | ✅ via `youtube-mcp` | — / `yt_reply_to_comment` |
| LinkedIn | ✅ Polling | ✅ `LinkedInApiClient` | ⚠️ Partner-only | ✅ via `linkedin-mcp` | `linkedin_send_message` / `linkedin_reply_to_comment` |
| Reddit | ✅ Polling | ❌ Not applicable | ✅ via `reddit-mcp` | ✅ via `reddit-mcp` | `reddit_send_message` / `reddit_reply_to_comment` |

---

## 3. Unit Tests

### 3.1 SocialRepository (CRM) — ✅ Complete

File: `src/channels/social/social-repository.test.ts` (19 tests)

Coverage includes: Contact CRUD (upsert, get, list, delete), message persistence, tag management, rule CRUD, automation log, post context cache, platform queries.

### 3.2 SocialIngestion — ✅ Complete

File: `src/channels/social/social-ingestion.test.ts` (23 tests)

Coverage includes:
- `InstagramAdapter.parseComment()` — valid payload parsing
- `InstagramAdapter.parseDM()` — DM payload parsing
- `FacebookAdapter` — Meta Page feed webhook parsing
- `TwitterAdapter` — Account Activity API event parsing + CRC validation
- `GenericPollAdapter` — `since` tracking, configurable intervals
- Normalization to `IncomingComment` interface for all platforms
- Duplicate comment deduplication
- Malformed webhook graceful handling
- Webhook signature verification (Meta, Twitter)

**Gaps to close:**
- [ ] `YouTubePollAdapter` instantiation and interval-based polling test
- [ ] `LinkedInPollAdapter` with conservative rate limiting
- [ ] `RedditPollAdapter` with `created_utc` tracking

### 3.3 SocialBrain (AI Engine) — ✅ Complete

File: `src/channels/social/social-brain.test.ts` (13 tests)

Coverage includes:

| Test Case | Status |
|-----------|--------|
| High confidence → emits "reply" | ✅ |
| Low confidence → emits "escalate" | ✅ |
| Contact in handoff → emits "escalated_message", returns null | ✅ |
| RAG context included in LLM prompt | ✅ |
| LLM timeout/error → graceful fallback to escalate | ✅ |
| Malformed LLM response (non-JSON) → raw text fallback | ✅ |
| `confidenceThreshold: "high"` escalates medium confidence | ✅ |
| Auto-reply logged as outbound message in CRM | ✅ |
| Missing/failing knowledge base → graceful degradation | ✅ |
| Platform metadata in LLM prompt | ✅ |
| Conversation history included in prompt | ✅ |
| Custom system prompt used when provided | ✅ |
| JSON parsed from markdown code block response | ✅ |

**Gaps to close:**
- [ ] Post context block (`postCaption`, `postUrl`) extracted from message metadata and injected into prompt
- [ ] `autoReplyEnabled: false` config toggle skips auto-send
- [ ] Multi-platform tone adaptation (formal for LinkedIn vs casual for Instagram)
- [ ] Rate limiting: same user reply throttling

### 3.4 CommentRuleEngine — ✅ Complete

File: `src/channels/social/comment-rule-engine.test.ts` (13 tests)

Coverage includes:

| Test Case | Status |
|-----------|--------|
| Keyword match triggers DM | ✅ |
| Keyword match triggers comment reply | ✅ |
| Regex fallback match | ✅ |
| Per-user trigger limit prevents re-trigger | ✅ |
| No match → no actions | ✅ |
| `enabled: 0` rule skipped | ✅ |
| Case-insensitive keyword matching | ✅ |
| Auto-tag on rule match | ✅ |
| Automation log entry created | ✅ |
| `rule_triggered` event emitted | ✅ |
| `max_triggers_total` cap | ✅ |
| `post_ids` scoping | ✅ |
| Template variable interpolation (`{{username}}`, `{{comment_text}}`, etc.) | ✅ |

**Gaps to close:**
- [ ] `dm_delay_seconds > 0` — scheduled DM (requires fake timers)
- [ ] Multiple rules evaluated in order; first match wins
- [ ] Rule engine when `sendDm` is not configured (comment-reply-only mode)

### 3.5 PlatformApiClient — ✅ Complete

File: `src/channels/social/platform-api-client.test.ts` (21 tests)

Coverage includes:

| Client | Tests |
|--------|-------|
| `InstagramApiClient` | Parses Graph API response, handles 401, handles 404 |
| `FacebookApiClient` | Parses Graph API response, handles 400 |
| `TwitterApiClient` | Parses v2 tweet response, handles 403 |
| `YouTubeApiClient` | Maps video snippet → PostContext |
| `LinkedInApiClient` | Maps URN-based response, handles 403 |
| `PostContextService` | 24h cache hit/miss, platform routing, cache expiry |

**Gaps to close:**
- [ ] `PostContextService` with all 5 platform clients registered — tests routing by platform prefix
- [ ] Rate limit handling (429) with retry-after
- [ ] Token refresh flow (mock refresh endpoint returning new token)

### 3.6 HandoffManager — ✅ Complete

File: `src/channels/social/handoff-manager.test.ts` (11 tests)

Coverage includes:

| Test Case | Status |
|-----------|--------|
| Creates Discord/Telegram thread on escalation | ✅ |
| Updates CRM `handoff_active`, `handoff_thread_id`, `handoff_channel` | ✅ |
| Tags contact with `handoff-active` | ✅ |
| Emits `escalated` event | ✅ |
| Forwards user messages to existing thread | ✅ |
| Returns null when no channel registered | ✅ |
| Routes admin reply back to contact, logs outbound message | ✅ |
| Archives thread and clears CRM state on close | ✅ |
| Emits `resolved` event with resolution | ✅ |
| Returns false when closing non-active handoff | ✅ |
| RAG context included in escalation thread message | ✅ |
| `handleAdminReply` returns null for unknown thread | ✅ |

**Gaps to close:**
- [ ] Telegram channel variant (same as Discord but `type: "telegram"`)
- [ ] `getContactByThread()` reverse lookup
- [ ] Thread map rebuilt from DB on `HandoffManager` constructor (restart scenario)
- [ ] `autoArchiveMinutes` — auto-close stale handoffs after timeout

### 3.7 DmDispatcher — ✅ Complete

File: `src/channels/social/dm-dispatcher.test.ts` (16 tests)

Coverage includes: DM routing for Instagram, Facebook, Twitter, LinkedIn, Reddit; YouTube throws (no DM API); comment reply routing for all 6 platforms (Instagram `reply_to_comment`, Facebook `fb_reply_to_comment`, Twitter `twitter_post_tweet` with `reply_to`, YouTube `yt_reply_to_comment`, LinkedIn `linkedin_reply_to_comment`, Reddit `reddit_reply_to_comment`); platform-specific argument mapping via `_buildReplyArgs()`; error propagation when `callTool` fails; graceful handling when server not running.

---

## 4. Integration Tests

### 4.1 Webhook → Ingestion → CRM Pipeline — ❌ Missing

File to create: `src/channels/social/social-ingestion.integration.test.ts`

```
Test: Full webhook-to-CRM flow (Instagram)
Setup:
  - In-memory SQLite database
  - Real SocialRepository + SocialIngestionService
  - Mock PostContextService (no real HTTP)
Steps:
  1. Construct valid Instagram comment webhook payload
  2. Call SocialIngestionService with the adapter-parsed result
  3. Assert: Contact created in DB with correct platform/username
  4. Assert: Message saved with correct content/metadata
  5. Assert: PostContextService called with correct postId
  6. Assert: "comment" event emitted with enriched IncomingComment

Repeat for: Facebook Page feed webhook, Twitter Account Activity event
```

### 4.2 Comment → RuleEngine → DmDispatcher Pipeline — ❌ Missing

File to create: `src/channels/social/social-pipeline.integration.test.ts`

```
Test: Full comment-to-DM automation flow
Setup:
  - In-memory SQLite + real SocialRepository + CommentRuleEngine
  - Mock DmDispatcher (intercept MCP tool calls)
Steps:
  1. Create keyword rule: ["pricing"] → DM template
  2. Ingest a comment containing "What's your pricing?"
  3. Assert: Rule engine matches → sendDm called with correct platform/userId
  4. Assert: Automation log entry created (dm_sent = 1)
  5. Assert: Contact auto-tagged if rule has auto_tag
  6. Assert: rule_triggered event emitted with correct payload
```

### 4.3 DM → Brain → Escalation Pipeline — ❌ Missing

```
Test: Low-confidence DM triggers HandoffManager
Setup:
  - In-memory SQLite + real SocialRepository + SocialBrain + HandoffManager
  - Mock CopilotWrapperService (returns low confidence)
  - Mock KnowledgeIngestionService
  - Mock HandoffChannel
Steps:
  1. Process a DM via SocialBrain
  2. Assert: LLM called with prompt including RAG context placeholder
  3. Assert: "escalate" event emitted
  4. Assert: HandoffManager creates Discord thread
  5. Assert: CRM contact updated with handoff_active = 1
```

### 4.4 Admin API → Social Endpoints — ❌ Missing

File to create: `src/api/admin-social.integration.test.ts`

```
Test: CRUD operations via REST API
Setup:
  - Express app with admin router mounted
  - In-memory SQLite database
Steps:
  1. GET /api/social/contacts → empty list
  2. POST webhook to create contact
  3. GET /api/social/contacts → 1 contact
  4. POST /api/social/contacts/:id/tags → tag added
  5. GET /api/social/rules → empty list
  6. POST /api/social/rules → rule created
  7. GET /api/social/rules/:id → rule returned
  8. POST webhook matching rule → automation log entry created
  9. GET /api/social/rules/log → shows execution
  10. POST /api/social/handoff/:id/close → handoff closed
```

---

## 5. End-to-End Tests

### 5.1 Instagram Comment → Auto-DM (Happy Path)

```
Preconditions:
  - INSTAGRAM_ACCESS_TOKEN set (even dummy value)
  - Knowledge base has product FAQ entries
  - Comment rule: "pricing" → trigger
  - Brain confidence threshold: "medium"

Steps:
  1. POST /api/social/webhooks/instagram with valid comment payload
     containing "What's your pricing for the pro plan?"
  2. Wait for async processing
  3. GET /api/social/activity → verify inbound comment logged
  4. GET /api/social/contacts → verify contact created
  5. GET /api/social/rules/log → verify rule triggered
  6. Verify DM dispatch attempted (check DmDispatcher callTool mock or logs)

Expected:
  - 200 OK on webhook receipt
  - Contact created with platform="instagram"
  - Automation log shows dm_sent=1
```

### 5.2 Facebook Comment → Auto-Reply

```
Steps:
  1. POST /api/social/webhooks/facebook with Page feed comment payload
  2. Assert: FacebookAdapter parses correctly
  3. Assert: Automation rule matches (same keywords as Instagram test)
  4. Assert: CommentReplier called (not DmSender, since comment reply)
  5. Assert: Contact created with platform="facebook"
```

### 5.3 Multi-Platform: Same User on Different Platforms

```
Steps:
  1. Instagram comment from user_123
  2. Facebook comment from user_123 (different platform_user_id)
  3. Assert: Two separate contacts created (platform isolation)
  4. Assert: No cross-platform message count bleed
```

### 5.4 Instagram DM → Brain Engine → Auto-Reply

```
Steps:
  1. POST webhook with DM payload (not a comment)
  2. Verify message goes to SocialBrain (bypasses rule engine)
  3. Verify Brain emits "reply" event
  4. Verify conversation thread maintained in CRM
```

### 5.5 Low-Confidence DM → Escalation → Discord Thread

```
Steps:
  1. Configure mock CopilotWrapper to return confidence: "low"
  2. POST DM webhook
  3. Assert: HandoffManager.escalate() called
  4. Assert: Discord/Telegram mock channel.createThread() called
  5. Assert: CRM contact has handoff_active = 1
```

### 5.6 YouTube Polling → Comment → Reply (No DM)

```
Steps:
  1. Start YouTube polling adapter with mocked API response
  2. Adapter polls, finds new comment
  3. CommentRuleEngine evaluates
  4. Assert: replyToComment called (via youtube-mcp)
  5. Assert: sendDm NOT called (YouTube has no DM API)
```

### 5.7 Rate Limit / Per-User Cooldown

```
Steps:
  1. Configure rule: max_triggers_per_user = 1
  2. Ingest first comment from user_A → rule triggers, DM sent
  3. Ingest second comment from user_A → rule does NOT trigger
  4. Verify automation_log has 1 entry with dm_sent=1
```

### 5.8 Admin UI — Local MCP Servers Panel

```
Steps:
  1. Navigate to /admin → expand "Local MCP Servers"
  2. Verify all 12 native servers appear:
     MarkItDown, Gmail, Database (JDBC), GitHub, Word/Office,
     Google Calendar, Instagram, Facebook/Meta Pages, Twitter/X,
     YouTube, LinkedIn, Reddit
  3. Verify "MCP Sidecars (Docker)" panel is GONE
  4. Verify credential input works for servers requiring env vars
  5. Verify running servers show tool count
```

---

## 6. Manual Test Procedures

### 6.1 Verify MCP Servers Are Native (No Docker Required)

```bash
# Confirm docker-compose has only 3 services
docker compose config --services
# Expected output:
# agent
# tunnel
# audio-sidecar

# Confirm NO sidecar definitions remain
grep -c "DockerSidecarManager\|DEFAULT_SIDECAR_DEFINITIONS" src/mcp/docker-sidecar-manager.ts
# The array should be empty []
```

### 6.2 Verify Admin UI Has No Docker Sidecars Panel

```bash
# Start the UI and check admin page
open http://localhost:3000/admin
# The "MCP Sidecars (Docker)" section should NOT appear
# "Local MCP Servers" should show all platforms including:
# Facebook / Meta Pages, Twitter / X, YouTube, LinkedIn, Reddit
```

### 6.3 Instagram Webhook Verification (curl)

```bash
# Verify webhook endpoint responds to Meta's verification challenge
curl "http://localhost:3000/api/social/webhooks/instagram?\
hub.mode=subscribe&\
hub.verify_token=YOUR_VERIFY_TOKEN&\
hub.challenge=test123"
# Expected: 200 with body "test123"
```

### 6.4 Simulate Instagram Comment (curl)

```bash
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "comments",
        "value": {
          "id": "comment_001",
          "text": "What is your pricing for the pro plan?",
          "from": {
            "id": "user_456",
            "username": "testuser"
          },
          "media": { "id": "post_789" }
        }
      }]
    }]
  }'
# Expected: {"received":true}
# Then verify:
curl http://localhost:3000/api/social/contacts | python3 -m json.tool
curl "http://localhost:3000/api/social/rules/log?limit=5" | python3 -m json.tool
```

### 6.5 Simulate Facebook Page Comment (curl)

```bash
curl -X POST http://localhost:3000/api/social/webhooks/facebook \
  -H "Content-Type: application/json" \
  -d '{
    "object": "page",
    "entry": [{
      "id": "PAGE_ID",
      "time": 1720000000,
      "changes": [{
        "field": "feed",
        "value": {
          "item": "comment",
          "comment_id": "comment_fb_001",
          "post_id": "fb_post_001",
          "message": "Interested in your product!",
          "from": { "id": "fb_user_123", "name": "Test User" },
          "created_time": 1720000000
        }
      }]
    }]
  }'
```

### 6.6 Simulate Twitter Mention (curl)

```bash
# Twitter Account Activity API event (CRC validation first)
curl "http://localhost:3000/api/social/webhooks/twitter?crc_token=test_crc"
# Expected: JSON with response_token

# Then simulate a mention event
curl -X POST http://localhost:3000/api/social/webhooks/twitter \
  -H "Content-Type: application/json" \
  -d '{
    "for_user_id": "YOUR_USER_ID",
    "tweet_create_events": [{
      "id_str": "tweet_123",
      "text": "@yourbrand What pricing plans do you offer?",
      "user": { "id_str": "tw_user_456", "screen_name": "twitteruser" },
      "in_reply_to_status_id_str": null
    }]
  }'
```

### 6.7 Verify CRM State

```bash
# List all contacts
curl http://localhost:3000/api/social/contacts | python3 -m json.tool

# Get contact's message history
CONTACT_ID=$(curl -s http://localhost:3000/api/social/contacts | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data'][0]['id'])")
curl "http://localhost:3000/api/social/contacts/$CONTACT_ID/messages" | python3 -m json.tool
```

### 6.8 Verify Handoff Flow

```bash
# Trigger a low-confidence escalation (with mock LLM returning low confidence)
# Check activity for escalation event
curl http://localhost:3000/api/social/activity | python3 -m json.tool

# Close a handoff
curl -X POST "http://localhost:3000/api/social/handoff/$CONTACT_ID/close" \
  -H "Content-Type: application/json" \
  -d '{"resolution": "Issue resolved — refund processed"}'
```

### 6.9 Native MCP Server Smoke Test

```bash
# Verify uvx is available for Python-based servers
which uvx && uvx --version

# Test the Instagram MCP server starts
cd external/ig-mcp
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | python src/instagram_mcp_server.py

# Test the Facebook MCP server starts (no credentials needed for tools/list)
cd external/fb-mcp
# same pattern
```

---

## 7. Performance & Load Testing

### 7.1 Webhook Throughput

```
Scenario: Burst of 100 comments in 10 seconds
Tool: Artillery or k6
Target: POST /api/social/webhooks/instagram
Metrics:
  - p99 latency < 500ms for webhook ACK
  - All 100 messages processed (check DB count)
  - No duplicate contacts created
  - Memory usage stays under baseline + 50MB
```

### 7.2 PostContextService Cache Performance

```
Scenario: 50 comments on the same post
Expected: 1 HTTP call to platform API, 49 SQLite cache hits
Metric: Only 1 cache miss logged
```

### 7.3 Brain Processing Latency

```
Scenario: Single DM with RAG + LLM
Target: < 5s for full brain processing (knowledge search + LLM call)
Note: LLM latency dominates; mock for deterministic unit tests
```

### 7.4 Multi-Platform Polling Load

```
Scenario: YouTube + LinkedIn + Reddit all polling simultaneously
Expected: No thread starvation, individual poll errors don't crash others
Metric: All adapters continue polling after one fails
```

---

## 8. Security Testing

### 8.1 Webhook Signature Verification

```
Test: Instagram webhook without valid X-Hub-Signature-256 header
Expected: 403 Forbidden (not 200)

Test: Facebook webhook with tampered body but valid old signature
Expected: 403 Forbidden

Test: Twitter CRC validation with invalid consumer secret
Expected: CRC response does not validate → registration rejected
```

### 8.2 SQL Injection in CRM

```
Test: Create contact with malicious username
Input: username = "'; DROP TABLE social_contacts; --"
Expected: Contact created (parameterized query, escaped), DB intact
```

### 8.3 XSS in Admin UI

```
Test: Contact display_name contains <script>alert('xss')</script>
Expected: Rendered as escaped text in React components, no script execution
```

### 8.4 Rate Limiting on Webhook Endpoint

```
Test: 1000 requests in 1 second to webhook endpoint
Expected: Rate limiter kicks in, returns 429 after threshold
```

### 8.5 Token Exposure

```
Test: Verify platform access tokens are not logged in plaintext
Audit: Check logger output for patterns matching bearer tokens
Expected: Tokens redacted in all log output
```

### 8.6 MCP Server Process Isolation

```
Test: Social MCP server process crashes
Expected: LocalMcpServerManager detects crash, logs error, does not crash agent
Test: Social MCP server emits error on malformed tool call
Expected: DmDispatcher catches error, logs gracefully, does not crash pipeline
```

---

## 9. Test Data & Fixtures

### Instagram Comment Webhook Fixture

```json
{
  "entry": [{
    "id": "17841400123456789",
    "time": 1720000000,
    "changes": [{
      "field": "comments",
      "value": {
        "id": "17858893269123456",
        "text": "Love this product! What's the pricing?",
        "from": {
          "id": "67890",
          "username": "curious_customer"
        },
        "media": { "id": "17846368219941692" }
      }
    }]
  }]
}
```

### Facebook Page Comment Webhook Fixture

```json
{
  "object": "page",
  "entry": [{
    "id": "PAGE_ID_123",
    "time": 1720000000,
    "changes": [{
      "field": "feed",
      "value": {
        "item": "comment",
        "comment_id": "fb_comment_001",
        "post_id": "fb_post_001_PAGE_ID_123",
        "message": "Interested in your new product launch!",
        "from": { "id": "fb_user_123", "name": "Facebook User" },
        "created_time": 1720000000
      }
    }]
  }]
}
```

### Twitter Account Activity Event Fixture

```json
{
  "for_user_id": "TW_USER_ID",
  "tweet_create_events": [{
    "id_str": "tweet_abc123",
    "text": "@yourbrand what are your pricing plans?",
    "user": {
      "id_str": "tw_user_456",
      "screen_name": "twitter_customer"
    },
    "in_reply_to_status_id_str": "original_tweet_123",
    "created_at": "Mon Jul 01 12:00:00 +0000 2026"
  }]
}
```

### Instagram DM Webhook Fixture

```json
{
  "entry": [{
    "id": "17841400123456789",
    "time": 1720000000,
    "messaging": [{
      "sender": {"id": "67890"},
      "recipient": {"id": "17841400123456789"},
      "timestamp": 1720000000000,
      "message": {
        "mid": "m_abc123",
        "text": "Hey, I have a question about your service"
      }
    }]
  }]
}
```

### Platform API Response Fixtures

#### Instagram Graph API (Post Context)

```json
{
  "id": "17846368219941692",
  "caption": "Introducing our new Pro Plan! 🚀 Enterprise features at startup prices.",
  "permalink": "https://www.instagram.com/p/ABC123/",
  "media_type": "IMAGE",
  "media_url": "https://scontent.cdninstagram.com/...",
  "username": "ourbrand",
  "timestamp": "2026-07-01T12:00:00+0000"
}
```

#### Facebook Graph API (Post Context)

```json
{
  "id": "fb_post_001",
  "message": "Introducing our new Pro Plan!",
  "permalink_url": "https://www.facebook.com/ourbrand/posts/123456",
  "type": "status",
  "created_time": "2026-07-01T12:00:00+0000",
  "from": { "id": "PAGE_ID", "name": "Our Brand" }
}
```

#### Twitter v2 Tweet (Post Context)

```json
{
  "data": {
    "id": "tweet_abc123",
    "text": "Introducing our new Pro Plan! Enterprise features at startup prices.",
    "created_at": "2026-07-01T12:00:00.000Z",
    "author_id": "TW_AUTHOR_ID"
  },
  "includes": {
    "users": [{ "id": "TW_AUTHOR_ID", "username": "ourbrand" }]
  }
}
```

### Brain Result Fixtures

```json
// High confidence — auto-reply
{
  "reply": "Thanks for your interest! Our Pro Plan starts at $49/month with a 14-day free trial. Check out the link in our bio for full pricing details!",
  "confidence": "high",
  "intent": "pricing inquiry"
}

// Low confidence — escalate
{
  "reply": "I'm not sure I fully understand your question. Let me connect you with our team who can help better.",
  "confidence": "low",
  "intent": "unclear request"
}
```

### CommentRule Fixture

```typescript
{
  name: "Pricing Interest",
  platform: "instagram",
  enabled: 1,
  post_ids: null,
  keywords: JSON.stringify(["interested", "pricing", "price", "how much", "cost"]),
  regex: null,
  comment_reply_template: "Thanks for asking! Check your DMs 📬",
  dm_template: "Hey {{username}}! Thanks for your interest in {{post_caption}}. Pricing starts at $49/month → {{post_url}}",
  dm_delay_seconds: 3,
  max_triggers_per_user: 1,
  max_triggers_total: null,
  auto_tag: "lead",
}
```

---

## 10. Coverage Matrix

| Component | Unit | Integration | E2E | Manual | Security |
|-----------|:----:|:-----------:|:---:|:------:|:--------:|
| SocialRepository (CRM) | ✅ 19 | 🔄 Pending | 🔄 Pending | ✅ | ✅ |
| SocialIngestion (all adapters) | ✅ 23 | ❌ Missing | 🔄 Pending | ✅ | ✅ |
| SocialBrain | ✅ 13 | ❌ Missing | 🔄 Pending | — | — |
| CommentRuleEngine | ✅ 13 | ❌ Missing | 🔄 Pending | — | — |
| PlatformApiClient (5 platforms) | ✅ 21 | — | 🔄 Pending | ✅ | ✅ |
| HandoffManager | ✅ 11 | ❌ Missing | 🔄 Pending | ✅ | — |
| DmDispatcher | ✅ 16 | — | 🔄 Pending | — | — |
| Admin API (social endpoints) | — | ❌ Missing | — | ✅ | ✅ |
| UI (Local MCP Servers panel) | — | — | ❌ Missing | ✅ | ✅ |
| Native MCP Servers (fb/tw/yt/li/rd) | ❌ Missing | — | 🔄 Pending | ✅ | ✅ |
| Native MCP Servers (ig) | ✅ (Python) | — | 🔄 Pending | ✅ | — |

**Legend:** ✅ Done · ❌ Missing · 🔄 Pending/Planned

### Priority Order for Remaining Work

1. **Integration: pipeline tests** — webhook → ingestion → rule → dispatch (#4.1, #4.2)
2. **Integration: DM → Brain → Escalation** (#4.3)
3. **Integration: Admin API** (#4.4)
4. **Unit: SocialIngestion poll adapter tests** (YouTube, LinkedIn, Reddit gaps)
5. **Unit: Python tests for fb-mcp, twitter-mcp, youtube-mcp, linkedin-mcp, reddit-mcp**
6. **E2E: Multi-platform scenarios** (#5.2–#5.6)
7. **Security tests** — webhook signatures, SQL injection, XSS
8. **Performance tests** — load test webhook throughput
