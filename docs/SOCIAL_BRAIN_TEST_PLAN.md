# Social Brain — Comprehensive Test Plan

> Feature: Social Brain (Issue #291)
> Owner: @mgcronin
> Last Updated: 2026-07-14

---

## Table of Contents

1. [Test Scope & Architecture Overview](#1-test-scope--architecture-overview)
2. [MCP Server Dependency Analysis](#2-mcp-server-dependency-analysis)
3. [Unit Tests](#3-unit-tests)
4. [Integration Tests](#4-integration-tests)
5. [End-to-End Tests](#5-end-to-end-tests)
6. [Manual Test Procedures](#6-manual-test-procedures)
7. [Performance & Load Testing](#7-performance--load-testing)
8. [Security Testing](#8-security-testing)
9. [MCP Server Evaluation & Build-vs-Buy Analysis](#9-mcp-server-evaluation--build-vs-buy-analysis)
10. [Test Data & Fixtures](#10-test-data--fixtures)
11. [Coverage Matrix](#11-coverage-matrix)

---

## 1. Test Scope & Architecture Overview

### Components Under Test

| # | Component | File | Current Tests |
|---|-----------|------|---------------|
| 1 | **SocialRepository** (CRM) | `src/channels/social/social-repository.ts` | ✅ `social-repository.test.ts` |
| 2 | **SocialIngestion** | `src/channels/social/social-ingestion.ts` | ❌ Missing |
| 3 | **SocialBrain** (AI Engine) | `src/channels/social/social-brain.ts` | ❌ Missing |
| 4 | **CommentRuleEngine** | `src/channels/social/comment-rule-engine.ts` | ❌ Missing |
| 5 | **PlatformApiClient** | `src/channels/social/platform-api-client.ts` | ❌ Missing |
| 6 | **HandoffManager** | `src/channels/social/handoff-manager.ts` | ❌ Missing |
| 7 | **Types** | `src/channels/social/types.ts` | N/A (type-only) |
| 8 | **Admin API routes** | `src/api/admin.ts` (social endpoints) | ❌ Missing |
| 9 | **UI – Social Brain page** | `ui/app/admin/social-brain/page.tsx` | ❌ Missing |
| 10 | **UI – CRM panel** | `ui/components/social/` | ❌ Missing |

### Data Flow Under Test

```
Webhook POST → InstagramAdapter.parse()
    → SocialIngestion.ingest()
        → SocialRepository.upsertContact()
        → SocialRepository.saveMessage()
        → PostContextService.enrichComment()   ← Direct HTTP (NOT MCP)
        → CommentRuleEngine.evaluate()
            → SocialBrain.process()
                → KnowledgeIngestionService.search()   ← Local RAG
                → CopilotWrapperService.chat()          ← LLM
                → emit("reply") or emit("escalate")
            → HandoffManager.enqueueDM()
```

### Critical Finding: MCP Independence

**Social Brain does NOT depend on any MCP servers for its core pipeline.** The architecture uses:

- **Direct webhook parsing** via `InstagramAdapter` (no external dependency)
- **Direct HTTP** to Instagram Graph API via `InstagramApiClient` (PostContextService)
- **Local RAG** via `KnowledgeIngestionService.search()` (SQLite + embeddings)
- **LLM generation** via `CopilotWrapperService.chat()` (ephemeral Copilot session)

The docker-compose MCP sidecars (LinkedIn, Twitter, Facebook, Pinterest) exist for the **chat tool interface** — e.g., the user typing "post to LinkedIn" in the chat window. They are NOT used by the Social Brain ingestion, brain, or handoff pipeline.

---

## 2. MCP Server Dependency Analysis

### What We Currently Have (docker-compose.yml)

| Service | Image | Port | Status |
|---------|-------|------|--------|
| `mcp-linkedin` | `ghcr.io/community/mcp-linkedin:latest` | 5101 | ⚠️ **Unverified** — no matching public repo found |
| `mcp-twitter` | `ghcr.io/community/mcp-twitter:latest` | 5102 | ⚠️ **Unverified** — no matching public repo found |
| `mcp-facebook` | `ghcr.io/community/facebook-mcp-server:latest` | 5103 | ⚠️ **Unverified** — no matching public repo found |
| `mcp-pinterest` | `ghcr.io/collactivelabs/pinterest-mcp-server:latest` | 5104 | ⚠️ **Unverified** — no matching public repo found |

**Critical Issue:** The `ghcr.io/community/*` container images referenced in docker-compose.yml do not correspond to any identifiable public GitHub repositories or published container packages. These appear to be placeholder images that may never have been published. Furthermore, `config/tools.json` has **zero social-platform-specific tools** registered, meaning even if the containers started, their tools would not appear in the chat interface.

### What Social Brain Actually Needs

For the **core pipeline** (comment → DM automation):
- ✅ Instagram Graph API access token (for PostContextService)
- ✅ Webhook endpoint exposed via Cloudflare tunnel
- ✅ Knowledge base populated with brand data
- ✅ LLM access (Copilot SDK)
- ❌ No MCP servers needed

For **chat tools** (human operators managing platforms):
- Optional: MCP servers that expose read/write tools for each platform
- Currently broken: the docker images are unverified

### Gaps Identified

| Gap | Impact | Priority |
|-----|--------|----------|
| Only Instagram has a `PlatformApiClient` | No post-context enrichment for YouTube, Twitter, TikTok, LinkedIn, Reddit comments | High |
| MCP sidecar images likely don't exist | Chat tools for social platforms won't work | Medium |
| No tools in `config/tools.json` for social platforms | Even if sidecars run, tools aren't registered | Medium |
| No GenericPollAdapter implementations | Polling-based platforms (YouTube, Reddit) have no ingestion path | High |

---

## 3. Unit Tests

### 3.1 SocialRepository (CRM) — ✅ Existing

File: `src/channels/social/social-repository.test.ts`

Existing coverage includes:
- Contact CRUD (upsert, get, list, delete)
- Message persistence (save, load history)
- Tag management
- Platform-specific queries

### 3.2 SocialIngestion — ❌ Needs Tests

File to create: `src/channels/social/social-ingestion.test.ts`

| Test Case | Description |
|-----------|-------------|
| `InstagramAdapter.parseComment()` | Parse a valid Instagram comment webhook payload |
| `InstagramAdapter.parseDM()` | Parse a valid Instagram DM webhook payload |
| `InstagramAdapter.parseComment() — missing fields` | Handle malformed webhook gracefully |
| `SocialIngestion.ingest() — new contact` | Verify CRM upsert for first-time commenter |
| `SocialIngestion.ingest() — existing contact` | Verify CRM update increments message count |
| `SocialIngestion.ingest() — comment enrichment` | Verify PostContextService called for comments |
| `SocialIngestion.ingest() — DM no enrichment` | Verify PostContextService NOT called for DMs |
| `SocialIngestion.ingest() — emit "message"` | Verify event emission with normalized message |
| `SocialIngestion.start() / stop()` | Verify lifecycle management |
| `GenericPollAdapter.poll()` | Mock polling a platform API and returning new messages |

**Mocking strategy:**
- Mock `PostContextService` to avoid real HTTP calls
- Mock `SocialRepository` with in-memory SQLite (`:memory:`)
- Use deterministic `clock` for timestamp assertions

### 3.3 SocialBrain (AI Engine) — ❌ Needs Tests

File to create: `src/channels/social/social-brain.test.ts`

| Test Case | Description |
|-----------|-------------|
| `process() — high confidence reply` | Mock LLM returns `{confidence: "high"}` → emits "reply" |
| `process() — low confidence escalate` | Mock LLM returns `{confidence: "low"}` → emits "escalate" |
| `process() — medium confidence with threshold=medium` | Threshold boundary test |
| `process() — knowledge context injection` | Verify RAG results are included in LLM prompt |
| `process() — post context injection` | Verify message.metadata.postContext is in prompt |
| `process() — conversation history` | Verify last N messages from CRM are included |
| `process() — LLM parse error` | LLM returns invalid JSON → graceful fallback to escalate |
| `process() — LLM timeout` | Copilot service throws → emits "escalate" with error info |
| `process() — empty knowledge base` | No RAG results → still generates reply with lower confidence |
| `process() — platform-aware tone` | System prompt references platform from message metadata |

**Mocking strategy:**
- Mock `CopilotWrapperService.chat()` to return controlled JSON
- Mock `KnowledgeIngestionService.search()` to return mock RAG results
- Use `vi.fn()` handlers on EventEmitter events to verify emit payloads

### 3.4 CommentRuleEngine — ❌ Needs Tests

File to create: `src/channels/social/comment-rule-engine.test.ts`

| Test Case | Description |
|-----------|-------------|
| `evaluate() — keyword trigger match` | Comment contains configured keyword → triggers DM |
| `evaluate() — no match` | Comment doesn't match any rule → no action |
| `evaluate() — regex pattern match` | Rule uses regex pattern → matches correctly |
| `evaluate() — cooldown enforcement` | Same user triggered recently → skip (cooldown active) |
| `evaluate() — per-post rules` | Rules scoped to specific posts |
| `evaluate() — multiple rules` | First matching rule wins |
| `evaluate() — disabled rule` | Rule with `enabled: false` → skipped |
| `addRule() / removeRule() / updateRule()` | CRUD operations on rule set |
| `evaluate() — blacklist filter` | Contact in blacklist → always skip |

### 3.5 PlatformApiClient — ❌ Needs Tests

File to create: `src/channels/social/platform-api-client.test.ts`

| Test Case | Description |
|-----------|-------------|
| `InstagramApiClient.fetchPostContext()` | Mock fetch returns Graph API response → parsed correctly |
| `InstagramApiClient.fetchPostContext() — 404` | Post not found → returns null gracefully |
| `InstagramApiClient.fetchPostContext() — expired token` | 401 response → throws with descriptive error |
| `PostContextService — cache hit` | Second call within TTL → returns cached, no HTTP |
| `PostContextService — cache miss` | Call after TTL → makes fresh HTTP request |
| `PostContextService — cache eviction` | Verify 24h TTL is respected |
| `PostContextService — platform routing` | Instagram ID → uses InstagramApiClient, unknown → returns null |

**Mocking strategy:**
- Mock `global.fetch` for HTTP assertions
- Use in-memory SQLite for cache table assertions
- Freeze time with `clock` parameter

### 3.6 HandoffManager — ❌ Needs Tests

File to create: `src/channels/social/handoff-manager.test.ts`

| Test Case | Description |
|-----------|-------------|
| `enqueueDM() — creates pending DM` | DM queued in repository with status "pending" |
| `enqueueDM() — auto-send mode` | With autoSend enabled → immediately sends via platform API |
| `processPendingDMs()` | Batch processes queued DMs |
| `sendDM() — success` | Platform API returns 200 → mark as "sent" |
| `sendDM() — failure` | Platform API returns error → mark as "failed", log error |
| `sendDM() — rate limit` | 429 response → requeue with backoff |
| `getHandoffQueue()` | Returns pending DMs with contact + message info |
| `approveDM() / rejectDM()` | Manual approval workflow |

---

## 4. Integration Tests

### 4.1 Webhook → Ingestion → CRM Pipeline

File: `src/channels/social/social-ingestion.integration.test.ts`

```
Test: Full webhook-to-CRM flow
Setup:
  - In-memory SQLite database
  - Real SocialRepository (not mocked)
  - Mock PostContextService
Steps:
  1. Construct a valid Instagram comment webhook payload
  2. Pass to InstagramAdapter.parse()
  3. Feed result to SocialIngestion.ingest()
  4. Assert: Contact created in DB with correct platform/handle
  5. Assert: Message saved in DB with correct content/metadata
  6. Assert: PostContextService called with correct postId
  7. Assert: "message" event emitted with enriched message
```

### 4.2 Ingestion → RuleEngine → Brain → Handoff Pipeline

File: `src/channels/social/social-pipeline.integration.test.ts`

```
Test: Full comment-to-DM automation flow
Setup:
  - In-memory SQLite database
  - Real SocialRepository + CommentRuleEngine
  - Mock CopilotWrapperService + KnowledgeIngestionService
  - Real HandoffManager
Steps:
  1. Configure a keyword rule: "pricing" → trigger DM
  2. Ingest a comment containing "What's your pricing?"
  3. Assert: Rule engine matches and triggers brain
  4. Assert: Brain processes with knowledge context
  5. Assert: Brain emits "reply" with confidence and response text
  6. Assert: HandoffManager enqueues a DM in the repository
  7. Assert: DM record contains correct recipient + reply text
```

### 4.3 Admin API → Social Brain Endpoints

File: `src/api/admin-social.integration.test.ts`

```
Test: CRUD operations via REST API
Setup:
  - Express app with admin router mounted
  - In-memory SQLite database
Steps:
  1. GET /api/admin/social/contacts → empty list
  2. POST /api/admin/social/contacts → create contact
  3. GET /api/admin/social/contacts/:id → verify created
  4. PUT /api/admin/social/contacts/:id/tags → add tag
  5. GET /api/admin/social/rules → list rules
  6. POST /api/admin/social/rules → create keyword rule
  7. GET /api/admin/social/handoff → empty queue
  8. GET /api/admin/social/config → verify config schema
  9. PUT /api/admin/social/config → update config
```

---

## 5. End-to-End Tests

### 5.1 Instagram Comment → Auto-DM (Happy Path)

```
Preconditions:
  - Instagram webhook configured (or mock webhook endpoint)
  - Knowledge base has product FAQ entries
  - Comment rule: "pricing" → trigger
  - Brain confidence threshold: "medium"

Steps:
  1. POST /api/admin/social/webhook/instagram with valid comment payload
     containing "What's your pricing for the pro plan?"
  2. Wait for async processing (poll /api/admin/social/handoff)
  3. Verify DM appears in handoff queue
  4. Verify DM content references pricing info from knowledge base
  5. Verify contact was created/updated in CRM
  6. Verify conversation history shows the inbound comment

Expected:
  - 200 OK on webhook receipt
  - DM in queue within 5 seconds
  - DM content is contextually relevant
  - Contact has platform="instagram" and correct handle
```

### 5.2 Instagram Comment → Escalation (Low Confidence)

```
Steps:
  1. Ingest a comment with obscure/off-topic content
  2. Brain returns low confidence
  3. Verify NO DM is queued
  4. Verify escalation event is emitted
  5. Verify Socket.IO notification sent to admin UI
```

### 5.3 Instagram DM → Auto-Reply

```
Steps:
  1. POST webhook with DM payload (not a comment)
  2. Verify message goes directly to Brain (bypasses rule engine)
  3. Verify reply generated and queued
  4. Verify conversation thread maintained in CRM
```

### 5.4 Rate Limit / Cooldown

```
Steps:
  1. Configure cooldown: 60 seconds per user
  2. Ingest first comment from user → DM queued
  3. Ingest second comment from same user within 60s → no DM
  4. Wait 60s, ingest third comment → DM queued again
```

### 5.5 UI Workflow — Admin Managing Social Brain

```
Steps:
  1. Navigate to /admin → Social Brain tab
  2. Verify CRM shows contacts list
  3. Click contact → see conversation history
  4. Navigate to Rules tab → create new keyword rule
  5. Navigate to Handoff tab → see pending DMs
  6. Approve/reject a pending DM
  7. Verify Platform Config shows connection status
  8. Update Instagram config → verify saved
```

---

## 6. Manual Test Procedures

### 6.1 Instagram Webhook Verification (curl)

```bash
# Verify webhook endpoint responds to Meta's verification challenge
curl "http://localhost:3000/api/admin/social/webhook/instagram?\
hub.mode=subscribe&\
hub.verify_token=YOUR_VERIFY_TOKEN&\
hub.challenge=test123"
# Expected: 200 with body "test123"
```

### 6.2 Simulate Instagram Comment (curl)

```bash
curl -X POST http://localhost:3000/api/admin/social/webhook/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "object": "instagram",
    "entry": [{
      "id": "PAGE_ID",
      "time": 1720000000,
      "changes": [{
        "field": "comments",
        "value": {
          "id": "COMMENT_ID_123",
          "text": "What is your pricing for the pro plan?",
          "from": {
            "id": "USER_ID_456",
            "username": "testuser"
          },
          "media": {
            "id": "POST_ID_789"
          }
        }
      }]
    }]
  }'
# Expected: 200 OK
# Then check: curl http://localhost:3000/api/admin/social/contacts
# Then check: curl http://localhost:3000/api/admin/social/handoff
```

### 6.3 Simulate Instagram DM (curl)

```bash
curl -X POST http://localhost:3000/api/admin/social/webhook/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "object": "instagram",
    "entry": [{
      "id": "PAGE_ID",
      "time": 1720000000,
      "messaging": [{
        "sender": {"id": "USER_ID_456"},
        "recipient": {"id": "PAGE_ID"},
        "timestamp": 1720000000000,
        "message": {
          "mid": "MSG_ID_001",
          "text": "Hey, I saw your post about the new product. Can you tell me more?"
        }
      }]
    }]
  }'
```

### 6.4 Verify CRM State

```bash
# List all contacts
curl http://localhost:3000/api/admin/social/contacts | jq

# Get specific contact
curl http://localhost:3000/api/admin/social/contacts/USER_ID_456 | jq

# Get conversation history
curl http://localhost:3000/api/admin/social/contacts/USER_ID_456/messages | jq
```

### 6.5 Verify Handoff Queue

```bash
# List pending DMs
curl http://localhost:3000/api/admin/social/handoff | jq

# Approve a DM
curl -X POST http://localhost:3000/api/admin/social/handoff/DM_ID/approve

# Reject a DM
curl -X POST http://localhost:3000/api/admin/social/handoff/DM_ID/reject
```

### 6.6 Docker Sidecar Smoke Test

```bash
# Check if social MCP sidecars actually start
docker compose up mcp-linkedin mcp-twitter mcp-facebook mcp-pinterest

# Expected: Most will FAIL because the images don't exist at ghcr.io/community/*
# This confirms the placeholder issue documented in Section 2.
```

---

## 7. Performance & Load Testing

### 7.1 Webhook Throughput

```
Scenario: Burst of 100 comments in 10 seconds
Tool: Artillery or k6
Target: POST /api/admin/social/webhook/instagram
Metrics:
  - p99 latency < 500ms for webhook ACK
  - All 100 messages processed (check DB count)
  - No duplicate contacts created
  - Memory usage stays under baseline + 50MB
```

### 7.2 PostContextService Cache Performance

```
Scenario: 50 comments on the same post
Expected: 1 HTTP call to Instagram Graph API, 49 cache hits
Metric: Only 1 cache miss logged
```

### 7.3 Brain Processing Latency

```
Scenario: Single message with RAG + LLM
Target: < 5s for full brain processing (knowledge search + LLM call)
Note: Depends on LLM latency; mock for deterministic tests
```

---

## 8. Security Testing

### 8.1 Webhook Signature Verification

```
Test: Instagram webhook without valid X-Hub-Signature-256 header
Expected: 403 Forbidden (not 200)
Test: Webhook with tampered body but valid old signature
Expected: 403 Forbidden
```

### 8.2 SQL Injection in CRM

```
Test: Create contact with malicious platform handle
Input: username = "'; DROP TABLE social_contacts; --"
Expected: Contact created (escaped), DB intact
```

### 8.3 XSS in Admin UI

```
Test: Contact display name contains <script>alert('xss')</script>
Expected: Rendered as escaped text, no script execution
```

### 8.4 Rate Limiting on Webhook Endpoint

```
Test: 1000 requests in 1 second to webhook endpoint
Expected: Rate limiter kicks in, returns 429 after threshold
```

### 8.5 Token Exposure

```
Test: Verify Instagram access tokens are not logged in plaintext
Audit: Check logger output for token patterns
Expected: Tokens redacted in all log output
```

---

## 9. MCP Server Evaluation & Build-vs-Buy Analysis

### Current Docker Sidecar Status

The four social MCP sidecars in `docker-compose.yml` reference `ghcr.io/community/*` images that **do not appear to be real published packages**. The images likely need to be replaced with verified, maintained alternatives or removed entirely.

### Available Third-Party MCP Servers (Research Summary)

#### Instagram

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **arjun1194/insta-mcp** | 5 | TypeScript | 30+ tools: DMs, posts, reels, analytics, search | Uses `instagram-private-api` (unofficial, ban risk) |
| **jlbadano/ig-mcp** | — | — | "Production-ready" Instagram Business | Unverified |
| **Xpoz-AI/xpoz** | — | Remote | Instagram + Twitter/X + TikTok data | Hosted service, privacy concern |

**Verdict:** No mature, well-maintained Instagram MCP server exists. Our own `external/ig-mcp/` is the best option for Instagram since we already built it with the official Graph API.

#### Twitter/X

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **adhikasp/mcp-twikit** | — | Python | Search + timeline via twikit | Unofficial API, scraping-based |
| **checkra1neth/xbird** | — | TypeScript | 34 tools, no API keys, uses cookies | Cookie auth, x402 micropayments |
| **kunallunia/twitter-mcp** | — | Python | Full management: timeline, DMs, hashtags, sentiment | Repo returned 404 |
| **BlockRunAI/x-grow** | — | TypeScript | Post drafting, algorithm optimization | Marketing-focused |
| **scrape-badger/scrapebadger-mcp** | — | Python | Profiles, tweets, followers, trends | Paid API service |

**Verdict:** No well-maintained, official-API-based Twitter MCP server. All rely on unofficial scraping or cookies. Best option: build a thin MCP server wrapping the Twitter API v2 (requires developer account).

#### YouTube

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **spolepaka/youtube-mcp** | — | — | NO API required, transcript extraction | Read-only, no comment management |
| **format37/youtube_mcp** | — | Python | Transcription via yt-dlp + Whisper | Audio transcription, not comments |
| **serpapi/serpapi-mcp** | — | Python | Multi-engine search including YouTube | Search only, requires paid SerpAPI key |
| **anwerj/youtube-uploader-mcp** | — | Go | Video uploading | Upload only |

**Verdict:** No YouTube MCP server provides comment management or comment-context retrieval. Would need a custom server wrapping the YouTube Data API v3.

#### TikTok

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **Seym0n/tiktok-mcp** | 130 | TypeScript | Subtitles, post details, search | Requires paid TikNeuron API key |
| **AdsMCP/tiktok-ads-mcp-server** | — | Python | TikTok Ads API | Ads-only, not content |
| **viral.app TikTok MCP** | — | — | Analytics | Hosted service |

**Verdict:** `Seym0n/tiktok-mcp` is the best option but requires a paid third-party API key. No free, official-API-based option exists.

#### Facebook

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **HagaiHen/facebook-mcp-server** | 101 | Python | 25+ tools: posts, comments, moderation, insights, DMs | Last updated 6 months ago, Python-only |
| **gomarble-ai/facebook-ads-mcp-server** | — | Python | Facebook Ads interface | Ads-only |
| **pipeboard-co/meta-ads-mcp** | — | Python | Meta Ads automation | Ads-only |

**Verdict:** `HagaiHen/facebook-mcp-server` is solid for Facebook Pages. Uses the official Graph API. Could be Dockerized and used as a sidecar.

#### LinkedIn

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **fredericbarthelet/mcp-server-linkedin** | — | TypeScript | LinkedIn API | Unclear scope/maintenance |
| **alexey-pelykh/lhremote** | — | TypeScript | 32 tools, LinkedHelper automation | Requires LinkedHelper subscription |
| **horizondatawave/hdw-mcp-server** | — | — | LinkedIn data via paid API | Paid service |

**Verdict:** No well-maintained, free LinkedIn MCP server. LinkedIn's API is extremely restrictive (requires partner program for most endpoints). Best option: build a minimal server for the specific endpoints your LinkedIn app has access to.

#### Reddit

| Server | Stars | Language | Key Features | Concern |
|--------|-------|----------|-------------|---------|
| **karanb192/reddit-mcp-buddy** | 381 | TypeScript | 5 tools, 3-tier auth, smart caching | Best in class, actively maintained, production-ready |
| **king-of-the-grackles/reddit-research-mcp** | — | Python | Market research, sentiment analysis | Research-focused |

**Verdict:** `reddit-mcp-buddy` is excellent — well-documented, TypeScript, actively maintained, 381 stars, no API key required for basic usage. **Recommended for adoption.**

### Build vs Buy Recommendation

| Platform | Recommendation | Rationale |
|----------|---------------|-----------|
| **Instagram** | **BUILD** (already have `external/ig-mcp/`) | We already built it. Official Graph API. No good third-party option. |
| **Twitter/X** | **BUILD** (thin wrapper) | No reliable third-party. Twitter API v2 is well-documented. Build a minimal MCP server with: search, get-tweet, get-user, post-tweet. |
| **YouTube** | **BUILD** (targeted) | No third-party covers comments. Build with YouTube Data API v3: get-video, list-comments, reply-to-comment. |
| **TikTok** | **BUY** (Seym0n/tiktok-mcp) or defer | Only viable option requires paid API. TikTok's official API is limited. Low priority unless TikTok is a key channel. |
| **Facebook** | **ADOPT** (HagaiHen/facebook-mcp-server) | Solid 101-star project with 25+ tools. Uses official Graph API. Fork and Dockerize. |
| **LinkedIn** | **BUILD** (minimal) | LinkedIn API severely restricted. Build only the endpoints your app credentials allow. |
| **Reddit** | **ADOPT** (reddit-mcp-buddy) | 381 stars, TypeScript, production-ready, actively maintained. Easy to Dockerize. |

### Overall Strategy

**Phase 1 — Fix what's broken:**
1. Remove or replace the phantom `ghcr.io/community/*` images in docker-compose.yml
2. Add tools from `external/ig-mcp/` to `config/tools.json` for Instagram
3. Adopt `reddit-mcp-buddy` and `HagaiHen/facebook-mcp-server` as Docker sidecars

**Phase 2 — Extend post-context enrichment:**
4. Implement `YouTubeApiClient` in `platform-api-client.ts` (YouTube Data API v3)
5. Implement `TwitterApiClient` in `platform-api-client.ts` (Twitter API v2)
6. These are direct HTTP clients (like `InstagramApiClient`), NOT MCP servers

**Phase 3 — Build custom MCP servers (for chat tools):**
7. Build `mcp-twitter` wrapping Twitter API v2 (TypeScript, SSE transport)
8. Build `mcp-youtube` wrapping YouTube Data API v3
9. Build `mcp-linkedin` wrapping LinkedIn Marketing API (scoped to your app credentials)

---

## 10. Test Data & Fixtures

### Instagram Comment Webhook Fixture

```json
{
  "object": "instagram",
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
        "media": {
          "id": "17846368219941692"
        }
      }
    }]
  }]
}
```

### Instagram DM Webhook Fixture

```json
{
  "object": "instagram",
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

### Instagram Graph API Response Fixture (Post Context)

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

### Brain Result Fixtures

```json
// High confidence reply
{
  "reply": "Thanks for your interest! Our Pro Plan starts at $49/month with a 14-day free trial. Check out the link in our bio for full pricing details!",
  "confidence": "high",
  "intent": "pricing inquiry"
}

// Low confidence (escalate)
{
  "reply": "I'm not sure I fully understand your question. Let me connect you with our team who can help better.",
  "confidence": "low",
  "intent": "unclear request"
}
```

---

## 11. Coverage Matrix

| Component | Unit | Integration | E2E | Manual | Security |
|-----------|------|-------------|-----|--------|----------|
| SocialRepository (CRM) | ✅ | ✅ | ✅ | ✅ | ✅ |
| SocialIngestion | ❌→✅ | ✅ | ✅ | ✅ | ✅ |
| SocialBrain | ❌→✅ | ✅ | ✅ | — | — |
| CommentRuleEngine | ❌→✅ | ✅ | ✅ | — | — |
| PlatformApiClient | ❌→✅ | — | ✅ | ✅ | ✅ |
| HandoffManager | ❌→✅ | ✅ | ✅ | ✅ | — |
| Admin API (social) | — | ✅ | — | ✅ | ✅ |
| UI (Social Brain page) | — | — | ✅ | ✅ | ✅ |
| MCP Sidecars | — | — | — | ✅ | — |

### Priority Order for Implementation

1. **SocialIngestion tests** — this is the entry point; if parsing breaks, everything breaks
2. **SocialBrain tests** — the AI core; must verify confidence-based routing
3. **CommentRuleEngine tests** — the trigger mechanism for comment-to-DM
4. **PlatformApiClient tests** — post context enrichment with cache behavior
5. **HandoffManager tests** — DM queue management
6. **Integration: pipeline tests** — end-to-end flow validation
7. **Security tests** — webhook signature, SQL injection, XSS
8. **Admin API tests** — REST endpoint validation
