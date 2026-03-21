# Social Brain — Comprehensive Setup & Platform Guide

This guide walks through every step needed to get Social Brain running: Cloudflare Tunnel exposure, platform-by-platform webhook/API configuration, CRM usage, automation rules, AI auto-replies, local testing with curl, and troubleshooting.

> **Prerequisite:** OpenZigs is installed and running. See the main [User Guide](USER_GUIDE.md) for installation instructions.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Ingestion Modes: Webhook vs Polling](#ingestion-modes-webhook-vs-polling)
- [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup)
  - [Prerequisites](#prerequisites)
  - [Option A: Quick Tunnel (Development)](#option-a-quick-tunnel-development)
  - [Option B: Named Tunnel (Production)](#option-b-named-tunnel-production)
  - [Option C: Docker Compose Tunnel](#option-c-docker-compose-tunnel)
  - [Verifying the Tunnel](#verifying-the-tunnel)
- [Environment Variables](#environment-variables)
- [Platform Setup Guides](#platform-setup-guides)
  - [Twitter / X](#twitter--x)
    - [Twitter/X DM Requirements — Recipient Privacy Settings](#twitterx-dm-requirements--recipient-privacy-settings)
  - [YouTube](#youtube)
    - [YouTube OAuth Setup](#youtube-oauth-setup)
    - [YouTube Upload Quota](#youtube-upload-quota)
  - [LinkedIn](#linkedin)
    - [LinkedIn OAuth Setup](#linkedin-oauth-setup)
    - [LinkedIn Comment Monitoring — Community Management API](#linkedin-comment-monitoring--community-management-api)
  - [Reddit](#reddit)
  - [TikTok](#tiktok)
  - [Facebook](#facebook)
  - [Instagram](#instagram)
- [Settings Tab — Connection Status](#settings-tab--connection-status)
- [CRM Usage Guide](#crm-usage-guide)
- [Automation Rules (Comment-to-DM)](#automation-rules-comment-to-dm)
- [AI Rule Generation](#ai-rule-generation)
- [Follow-Up Sequences](#follow-up-sequences)
- [AI Auto-Reply (Brain Engine)](#ai-auto-reply-brain-engine)
- [AI Comment Replies](#ai-comment-replies)
- [Approval Queue](#approval-queue)
- [Voice Learning (Episodic Memory)](#voice-learning-episodic-memory)
- [Manual Reply (Compose UI)](#manual-reply-compose-ui)
- [Push Notifications](#push-notifications)
- [Human Handoff](#human-handoff)
- [Leads Tab](#leads-tab)
- [Analytics Tab](#analytics-tab)
- [MCP Tools (Chat Interface)](#mcp-tools-chat-interface)
  - [Social CRM Tools](#social-crm-tools)
  - [Platform-Specific Tools](#platform-specific-tools)
- [Posting to Social Media](#posting-to-social-media)
- [Native MCP Server Configuration](#native-mcp-server-configuration)
- [Testing with Curl](#testing-with-curl)
  - [Simulating a Twitter Mention](#simulating-a-twitter-mention)
  - [CRM and Activity Endpoints](#crm-and-activity-endpoints)
  - [Automation Rules CRUD](#automation-rules-crud)
  - [End-to-End Test Flow](#end-to-end-test-flow)
- [Troubleshooting](#troubleshooting)
- [AI-Assisted Platform Setup (Setup Wizard Agent)](#ai-assisted-platform-setup-setup-wizard-agent)
- [REST API Reference](#rest-api-reference)

---

## Architecture Overview

```
                                     ┌─────────────────────┐
  Twitter   ─── polling ────────────►│                     │
  TikTok    ─── webhook POST ───────►│  Cloudflare Tunnel  │
  YouTube   ─── polling ────────────►│   (cloudflared)     │
  LinkedIn  ─── polling ────────────►│                     │
  Reddit    ─── polling ────────────►│                     │
  Facebook  ─── polling ────────────►│                     │
  Instagram ─── polling ─────────────►└────────┬────────────┘
                                              │ http://localhost:3000
                                              ▼
                                   ┌──────────────────────┐
                                   │  /api/social/webhooks │
                                   │  /:platform           │
                                   └────────┬─────────────┘
                                            │
                         ┌──────────────────┼──────────────────┐
                         ▼                  ▼                  ▼
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
                 │  Ingestion   │  │ Comment Rule │  │   Social Brain   │
                 │  Service     │  │   Engine     │  │   (AI Reply)     │
                 │  (normalize) │  │  (keyword →  │  │  (RAG + LLM)    │
                 │              │  │ DM/reply)    │  │                  │
                 └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘
                        │                 │                    │
                        ▼                 ▼                    ▼
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
                 │  CRM (SQLite)│  │ DmDispatcher │  │  Handoff Manager │
                 │  contacts,   │  │  (routes DMs │  │  (Discord/       │
                 │  messages,   │  │  and replies │  │   Telegram)      │
                 │  rules, log  │  │  to native   │  └──────────────────┘
                 └──────────────┘  │  MCP servers)│
                                   └──────┬───────┘
                                          │
              ┌───────────────────────────┼────────────────────────────┐
              ▼                           ▼                            ▼
   ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
   │  twitter-mcp        │  │  linkedin-mcp       │  │  youtube-mcp        │
   │  (Python) native    │  │  (Python) native    │  │  (Python) native    │
   │  stdio subprocess   │  │  stdio subprocess   │  │  stdio subprocess   │
   └─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

**Data flow:**

1. Platform sends webhook / polling adapter fetches new comments → Cloudflare Tunnel → OpenZigs
2. Platform adapter parses the payload into a normalised `IncomingComment` or `IncomingMessage`
3. Comments are enriched with post context (caption, permalink) via the platform's HTTP API (`PlatformApiClient`)
4. Comment Rule Engine evaluates keyword/regex rules for comment-to-DM and comment-reply automation
5. DMs are processed by the Brain Engine (RAG + LLM) for AI auto-replies
6. `DmDispatcher` routes DMs and comment replies to the correct native MCP server subprocess
7. Low-confidence replies are escalated to a human via Discord/Telegram handoff
8. Everything is logged in the CRM (contacts, messages, automation log)

### MCP Server Architecture

All social platform interactions use **native MCP servers** (stdio subprocess transport, managed by `LocalMcpServerManager`). There are no Docker MCP sidecars. The native servers start automatically when the agent boots, provided the required credentials are configured.

| MCP Server | Runtime | Tools | Used For |
|------------|---------|-------|----------|
| `twitter-mcp` | Python (uvx) | 8 | Twitter DMs (`twitter_send_dm`), tweet replies (`twitter_post_tweet` w/ `reply_to`), search |
| `youtube-mcp` | Python (uvx) | 8 | YouTube **video upload** (`yt_upload_video`), comment replies (`yt_reply_to_comment`), video search, analytics (no DM API) |
| `linkedin-mcp` | Python (uvx) | 8 | LinkedIn DMs (`linkedin_send_message`, partner-only), comment replies (`linkedin_reply_to_comment`) |
| `reddit-mcp` | Python (uvx) | 8 | Reddit messages (`reddit_send_message`), comment replies (`reddit_reply_to_comment`), search |
| `fb-mcp` | Python (uvx) | 10 | Facebook Page posts, comments (`fb_get_post_comments`), replies (`fb_reply_to_comment`), Messenger (`fb_send_message`), insights |
| `ig-mcp` | Python (uvx) | 11 | Instagram comments, DMs, media publishing, business account info, insights |

The `DmDispatcher` (`src/channels/social/dm-dispatcher.ts`) provides a platform-agnostic interface over these servers. It maps Social Brain's `sendDm(platform, userId, text)` and `replyToComment(platform, commentId, text)` calls to the correct MCP server tool with platform-specific parameter names.

---

## Ingestion Modes: Webhook vs Polling

Social Brain supports two methods for receiving comments and messages from social platforms:

### Webhook Mode

In webhook mode, the platform (Meta, X, TikTok) sends HTTP POST requests to your server when new events occur. This provides **near-instant delivery** but requires:

- A publicly accessible HTTPS URL (via Cloudflare Tunnel)
- Platform app configuration and approval
- For Meta platforms (Facebook, Instagram): **production-approved apps only** — development mode apps do not receive webhook events from real users

**Platforms supporting webhooks:** Twitter/X, TikTok, Facebook, Instagram

### Polling Mode

In polling mode, Social Brain periodically fetches new content using the platform's read APIs via MCP servers. Polling is:

- **Recommended for development** — works without production approval
- Self-contained — no public URL or webhook subscriptions needed
- Configurable via `pollIntervalSeconds` (default: 120 seconds)
- Slightly delayed — new comments appear at the next poll cycle

**Polling workflow:**
1. On each poll interval, the adapter fetches recent posts from your account
2. For each post, it fetches comments
3. Comments newer than the last poll timestamp are delivered to Social Brain
4. Self-authored comments (from your own account) are filtered out

### Platform Mode Support

| Platform | Webhook | Polling | Default | Notes |
|----------|---------|---------|---------|-------|
| Twitter/X | ✅ | ✅ | polling | Webhook requires Account Activity API setup |
| YouTube | ❌ | ✅ | polling | No webhook support — polling only |
| LinkedIn | ❌ | ✅ | polling | No webhook support — polling only |
| Reddit | ❌ | ✅ | polling | No webhook support — polling only |
| TikTok | ✅ | ❌ | webhook | Webhook only — no polling adapter |
| Facebook | ✅ | ✅ | polling | **Use polling** unless Meta app is published |
| Instagram | ✅ | ✅ | polling | **Use polling** unless Meta app is published |

### Configuring the Mode

Set the mode in `~/.openzigs/config.json`:

```json
{
  "socialBrain": {
    "connections": {
      "facebook": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      },
      "instagram": {
        "enabled": true,
        "mode": "polling"
      },
      "twitter": {
        "enabled": true,
        "mode": "polling"
      }
    }
  }
}
```

Or use the **mode dropdown** on each platform card in the Social Brain **Settings** tab. Changes require a server restart to take effect.

### When to Use Each Mode

| Scenario | Recommended Mode |
|----------|------------------|
| Development / testing | **Polling** — works without production approval |
| Meta app in development mode | **Polling** — Meta doesn't deliver webhooks in dev mode |
| Production-approved Meta app | Webhook (lower latency) or Polling (simpler) |
| Twitter with Account Activity API | Webhook (near-instant) or Polling (simpler setup) |
| Maximum simplicity | **Polling** — no tunnel or webhook config needed |

---

## Cloudflare Tunnel Setup

Social Brain needs a **publicly reachable HTTPS URL** so that platforms (Meta, Google, X, TikTok) can deliver webhook payloads to your server. OpenZigs has built-in Cloudflare Tunnel support for this.

> **Already using the tunnel?** If you already have a Cloudflare Tunnel running for other OpenZigs features (e.g., Multiplayer Presenter, Telegram webhooks), your Social Brain webhooks will work automatically — they share the same origin port. Skip to [Verifying the Tunnel](#verifying-the-tunnel).

### Prerequisites

1. **Install cloudflared:**

   ```bash
   # macOS
   brew install cloudflared

   # Linux (Debian/Ubuntu)
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
   sudo dpkg -i cloudflared.deb

   # Windows (via winget)
   winget install Cloudflare.cloudflared

   # Verify installation
   cloudflared --version
   ```

2. **Cloudflare account** — Free tier is sufficient. Sign up at [cloudflare.com](https://www.cloudflare.com/).

3. **A domain** (for named tunnels only) — must be registered in Cloudflare DNS. Quick tunnels don't require a domain.

### Option A: Quick Tunnel (Development)

A quick tunnel creates a temporary public URL with zero configuration. The URL is random and changes each time you restart.

```bash
# Start OpenZigs first
pnpm dev  # runs on localhost:3000

# In another terminal, start the quick tunnel
cloudflared tunnel --url http://localhost:3000
```

**Output:**

```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://random-words-1234.trycloudflare.com
```

Copy this URL — you'll use it as the webhook callback URL in platform developer portals.

> **Tip:** Quick tunnels are great for development and testing. The URL changes on restart, so you'll need to update webhook registrations each time.

**Or enable it in OpenZigs config (`~/.openzigs/config.json`):**

```json
{
  "tunnel": {
    "enabled": true,
    "mode": "quick"
  }
}
```

When `tunnel.enabled` is `true`, OpenZigs starts `cloudflared` automatically on boot. The public URL is logged to the console and emitted as a Socket.IO event.

### Option B: Named Tunnel (Production)

A named tunnel gives you a **permanent, stable URL** tied to your domain. This is what you want for production webhook registrations.

**Step 1 — Authenticate with Cloudflare:**

```bash
cloudflared tunnel login
```

This opens a browser window. Select the domain you want to use and authorize. A certificate is saved to `~/.cloudflared/cert.pem`.

**Step 2 — Create the tunnel:**

```bash
cloudflared tunnel create openzigs
```

Output:

```
Created tunnel openzigs with id ae21a96c-24d1-4ce8-a6ba-962cba5976d3
Credentials written to ~/.cloudflared/ae21a96c-24d1-4ce8-a6ba-962cba5976d3.json
```

Save the tunnel ID and credentials file path.

**Step 3 — Route DNS:**

```bash
cloudflared tunnel route dns openzigs agent.yourdomain.com
```

This creates a CNAME record in Cloudflare DNS pointing `agent.yourdomain.com` to your tunnel.

**Step 4 — Create the config file:**

Create or edit `~/.cloudflared/config.yml`:

```yaml
tunnel: ae21a96c-24d1-4ce8-a6ba-962cba5976d3
credentials-file: /Users/you/.cloudflared/ae21a96c-24d1-4ce8-a6ba-962cba5976d3.json

ingress:
  - hostname: agent.yourdomain.com
    service: http://localhost:3000
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
```

**Step 5 — Run the tunnel:**

```bash
cloudflared tunnel run openzigs
```

The tunnel is now live at `https://agent.yourdomain.com`. All paths including `/api/social/webhooks/*` are proxied.

**Step 6 — Configure OpenZigs:**

Edit `~/.openzigs/config.json`:

```json
{
  "tunnel": {
    "enabled": true,
    "mode": "named",
    "namedTunnel": {
      "credentialsFile": "/Users/you/.cloudflared/ae21a96c-24d1-4ce8-a6ba-962cba5976d3.json",
      "hostname": "agent.yourdomain.com"
    }
  }
}
```

**Step 7 — (Optional) Run as a system service:**

```bash
# Install cloudflared as a system service (runs on boot)
sudo cloudflared service install
```

The service reads `~/.cloudflared/config.yml` automatically.

### Option C: Docker Compose Tunnel

If running OpenZigs via Docker, the tunnel is already configured in `docker-compose.yml`:

```bash
# Set your tunnel token
echo "TUNNEL_TOKEN=your-cloudflare-tunnel-token" >> .env

# Start everything including the tunnel
docker compose up -d
```

The Docker tunnel sidecar connects to Cloudflare using the `TUNNEL_TOKEN` (generated in the Cloudflare Zero Trust dashboard under **Networks → Tunnels → Create a tunnel → Cloudflared connector**).

> **Note:** Docker Compose only contains `agent`, `tunnel`, and `audio-sidecar` services. All social MCP servers run as native subprocesses inside the `agent` container — they are not separate Docker services.

### Verifying the Tunnel

Once the tunnel is running, verify it can reach your Social Brain webhook endpoints:

```bash
# Replace with your actual tunnel URL
export TUNNEL_URL="https://agent.yourdomain.com"

# Test the webhook verification endpoint (should return 403 — that's correct, no verify token was sent)
curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/api/social/webhooks/instagram?hub.mode=subscribe&hub.challenge=test123&hub.verify_token=wrong"
# Expected: 403

# Test with the correct verify token
curl -s "$TUNNEL_URL/api/social/webhooks/instagram?hub.mode=subscribe&hub.challenge=test123&hub.verify_token=$SOCIAL_WEBHOOK_VERIFY_TOKEN"
# Expected: test123

# Test the stats endpoint
curl -s "$TUNNEL_URL/api/social/stats" | python3 -m json.tool
```

---

## Environment Variables

Add these to your `.env` file at the project root:

```dotenv
# ── Required for Social Brain ──
SOCIAL_WEBHOOK_VERIFY_TOKEN=your-random-secret-string   # Used by TikTok to verify webhook subscriptions

# ── Twitter / X ──
TWITTER_BEARER_TOKEN=your-twitter-bearer-token
TWITTER_API_KEY=your-twitter-api-key
TWITTER_API_SECRET=your-twitter-api-key-secret

# ── YouTube (Data API v3 — API key for reads, OAuth token for writes: comment replies + video uploads) ──
YOUTUBE_API_KEY=your-youtube-data-api-v3-key
YOUTUBE_OAUTH_TOKEN=your-youtube-oauth-token  # Required for uploads and comment replies (scope: youtube.upload)

# ── LinkedIn (OAuth2 — set Client ID + Secret, then use Admin UI to complete OAuth flow) ──
LINKEDIN_CLIENT_ID=your-linkedin-client-id
LINKEDIN_CLIENT_SECRET=your-linkedin-client-secret
# LINKEDIN_ACCESS_TOKEN, LINKEDIN_REFRESH_TOKEN, LINKEDIN_TOKEN_EXPIRES_AT are set automatically by the OAuth flow

# ── Reddit (OAuth2 script app) ──
REDDIT_CLIENT_ID=your-reddit-client-id
REDDIT_CLIENT_SECRET=your-reddit-client-secret
REDDIT_USERNAME=your-reddit-bot-username
REDDIT_PASSWORD=your-reddit-bot-password

# ── TikTok (if configured) ──
# TIKTOK_ACCESS_TOKEN=your-tiktok-access-token

# ── Facebook (Page API + Messenger) ──
FACEBOOK_APP_ID=your-facebook-app-id
FACEBOOK_APP_SECRET=your-facebook-app-secret
FACEBOOK_PAGE_TOKEN=your-facebook-page-access-token
FACEBOOK_PAGE_ID=your-facebook-page-id

# ── Instagram (Graph API) ──
INSTAGRAM_ACCESS_TOKEN=your-instagram-long-lived-user-access-token
INSTAGRAM_BUSINESS_ACCOUNT_ID=your-instagram-business-account-id
```

Generate a random verify token:

```bash
openssl rand -hex 32
```

### Config File

Platform connections can also be configured in `~/.openzigs/config.json`:

```json
{
  "socialBrain": {
    "enabled": true,
    "confidenceThreshold": "medium",
    "handoff": {
      "preferredChannel": "discord",
      "autoArchiveMinutes": 60
    },
    "connections": {
      "twitter": {
        "enabled": true,
        "mode": "webhook"
      },
      "youtube": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      },
      "linkedin": {
        "enabled": true,
        "mode": "webhook",
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      },
      "reddit": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      }
    }
  }
}
```

> **Note:** Environment variables take precedence over config file values.

---

## Platform Setup Guides

Each platform requires specific API credentials and setup. The guides below walk through every step. All Python-based MCP servers require **Python 3.10+** with a virtual environment — see the venv setup command in each platform's section.

| Platform | Difficulty | Token Expiry | App Review Required? |
|---|---|---|---|
| Twitter/X | Easy | Permanent (bearer) | No |
| YouTube | Medium | OAuth ~1 hr (auto-refreshed) | No (personal use) |
| Reddit | Easy | Auto-managed | No |
| LinkedIn | Medium | 60 days (auto-refreshable) | For DMs only |
| Pinterest | Medium | 30 days (refreshable) | No (sandbox) |
| Facebook | Hard | Permanent (page tokens) | Not for page owner |
| Instagram | Hard | 60 days (must refresh) | For DMs only |
| TikTok | Easy | None (API key) | No |

### YouTube

YouTube does not support traditional webhooks for comments. There are two approaches:

#### Approach A: PubSubHubbub Push Notifications (Video Uploads Only)

YouTube supports [PubSubHubbub](https://pubsubhubbub.appspot.com/) for push notifications when a channel uploads a new video or updates a video title/description. **This does not cover comments.**

**Subscribe to a channel's feed:**

```bash
curl -X POST https://pubsubhubbub.appspot.com/subscribe \
  -d "hub.callback=https://<your-tunnel-url>/api/social/webhooks/youtube" \
  -d "hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=YOUR_CHANNEL_ID" \
  -d "hub.verify=async" \
  -d "hub.mode=subscribe" \
  -d "hub.verify_token=$SOCIAL_WEBHOOK_VERIFY_TOKEN"
```

#### Approach B: Polling with YouTube Data API v3 (Comments)

For comment monitoring, use the polling adapter pattern with the YouTube Data API:

**1. Get a YouTube Data API key:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for **YouTube Data API v3** and click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → API Key**
7. Copy the key and set it as `YOUTUBE_API_KEY` in your `.env`

**2. Enable polling in config:**

```json
{
  "socialBrain": {
    "connections": {
      "youtube": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      }
    }
  }
}
```

**3. YouTube API usage:**

The polling adapter calls these endpoints:

```bash
# List comments on a video
curl "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=VIDEO_ID&key=YOUR_API_KEY&maxResults=20&order=time"

# Reply to a comment (via youtube-mcp server tool)
# Called automatically by the DmDispatcher — not a direct API call
```

> **Quota:** YouTube Data API has a daily quota of 10,000 units. `commentThreads.list` costs 1 unit per call. With 120-second polling on 5 videos, that's ~3,600 calls/day — well within the free quota.

**4. Responding to comments:**

YouTube does not support DMs. The automation can:
- Reply to comments via the `youtube-mcp` native server (calling `reply-to-comment` tool)
- Upload videos via the `yt_upload_video` tool (resumable upload protocol)
- Auto-tag contacts in the CRM for follow-up

#### YouTube OAuth Setup

Comment replies and video uploads require OAuth 2.0 — an API key alone is only sufficient for read operations. OpenZigs includes a **built-in OAuth flow** in the Admin panel that handles token exchange, storage, and automatic refresh. You do not need to copy tokens manually or use the OAuth Playground.

**API key vs OAuth — what each unlocks:**

| Capability | API Key only | API Key + OAuth |
|---|---|---|
| List videos, search, analytics | ✅ | ✅ |
| Read comments | ✅ | ✅ |
| Reply to comments | ❌ | ✅ |
| Upload videos | ❌ | ✅ |
| Automatic token refresh | ❌ | ✅ (every 15 min) |

**Step 1 — Create a Google Cloud project and enable the API:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project → New Project**. Give it a name (e.g., "OpenZigs") and click **Create**.
3. Navigate to **APIs & Services → Library**.
4. Search for **YouTube Data API v3** and click **Enable**.

**Step 2 — Configure the OAuth consent screen:**

5. Navigate to **APIs & Services → OAuth consent screen**.
6. Select **User Type: External** (required even if you only authorize yourself — "Internal" only works for Google Workspace organizations).
7. Fill in the required fields: App name, support email, developer contact email.
8. Skip Scopes — OpenZigs requests them automatically at the authorization step.
9. Under **Test users**, click **Add users** and add your Google account email. You must be listed here to authorize in Testing mode.
10. Save and continue.

> **Testing vs Production:** Keep the app in Testing mode — it limits authorization to users on your test list. **Important:** Google's restricted scopes (`youtube.force-ssl`, `youtube.upload`) cause refresh tokens to expire after **7 days** in Testing mode, requiring weekly re-authorization. To avoid this, publish the app on the OAuth consent screen (unverified apps are capped at 100 users, which is fine for personal use).

**Step 3 — Create an OAuth 2.0 client:**

11. Navigate to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
12. Application type: **Web application** (not Desktop — Desktop clients do not support redirect URIs).
13. Under **Authorized redirect URIs**, click **Add URI** and enter exactly:
    ```
    http://localhost:3000/api/youtube/oauth/callback
    ```
14. Click **Create**. Copy the **Client ID** and **Client Secret**.

**Step 4 — Connect in the Admin panel:**

15. Open **Admin → Social Brain → YouTube → Edit App Credentials**.
16. Paste your Client ID and Client Secret. Click **Save App Credentials**.
17. Click **Connect via OAuth**. A Google sign-in window opens in your browser.
18. If you see **"Google hasn't verified this app"**, click **Continue** — this is expected for personal/development apps in Testing mode.
19. Grant the requested YouTube permissions and click **Allow**.
20. You are redirected back to the Admin panel. `YOUTUBE_OAUTH_TOKEN`, `YOUTUBE_REFRESH_TOKEN`, and `YOUTUBE_TOKEN_EXPIRES_AT` are saved to `.env` automatically.

**Stored environment variables (set automatically — do not edit manually):**

```dotenv
YOUTUBE_CLIENT_ID=827012501185-xxxx.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-xxxx
YOUTUBE_OAUTH_TOKEN=ya29.a0AfH6SM...   # expires in ~1 hour; auto-refreshed
YOUTUBE_REFRESH_TOKEN=1//0g...          # long-lived; used to renew access token
YOUTUBE_TOKEN_EXPIRES_AT=1745000000000  # epoch ms
```

> **Automatic token refresh:** OpenZigs refreshes the access token every 15 minutes when it is within 30 minutes of expiry. No manual action is needed.

**Admin UI display:** After saving, the YouTube section in Admin → Social Brain shows:
- **API Key:** masked (e.g., `AIzaSy…vmGQ`)
- **Channel ID:** displayed as-is (e.g., `UCxxxxxxxxxxxxxxxxxx` or your custom value)
- **Channel Handle:** displayed as-is (e.g., `@OpenZigs`)

The input fields below the status display are for *updating* values — they start blank intentionally. If the section appears collapsed, click the header to expand it.

#### YouTube Upload Quota

Each `yt_upload_video` call consumes **1,600 quota units** out of the default **10,000 daily quota**, limiting uploads to approximately **6 per day**. Other operations cost far less:

| Operation | Quota Cost | ~Daily Limit |
|-----------|-----------|-------------|
| `videos.insert` (upload) | 1,600 | ~6 |
| `commentThreads.list` | 1 | 10,000 |
| `comments.insert` (reply) | 50 | 200 |
| `search.list` | 100 | 100 |
| `channels.list` | 1 | 10,000 |

You can request a quota increase via the [Google Cloud Console Quotas page](https://console.cloud.google.com/iam-admin/quotas) if you need more uploads per day.

> **Unverified API projects:** Videos uploaded from unverified API projects (created after July 28, 2020) are restricted to **private** viewing only. Your Google Cloud project must pass an [API audit](https://support.google.com/youtube/contact/yt_api_form) to allow public/unlisted uploads.

---

### Twitter / X

Twitter/X webhook support depends on your API access tier.

**Difficulty:** Easy | **Token Expiry:** Bearer tokens are permanent; OAuth 2.0 access tokens expire but are refreshable with `offline.access` scope | **App Review:** Not required for personal use

#### Step-by-Step Setup

**1. Create a Developer Account and App:**

1. Go to the [X Developer Portal](https://developer.x.com/en/portal/dashboard) and sign in with your X account.
2. Accept the **Developer Agreement** and complete account verification if prompted.
3. Create a new **Project** — give it a name and select a use case.
4. Create an **App** inside the project.
5. Under **Keys and Tokens**, copy the following (shown only once — save them immediately):
   - **Bearer Token** — for app-level read access
   - **API Key** (Consumer Key) and **API Secret** (Consumer Secret) — for OAuth 1.0a
6. (Optional) Generate **Access Token** and **Access Token Secret** under the same section — needed for OAuth 1.0a user-context operations like sending DMs and posting tweets.

> **Important:** If you change your app's permission level (e.g., from Read to Read & Write), you must **regenerate** your Access Token and Access Token Secret for the new permissions to take effect.

**2. Authentication options:**

| Auth Method | Use Case | Tokens Needed |
|---|---|---|
| **App-only Bearer Token** | Read-only: search tweets, get user info | Bearer Token only |
| **OAuth 1.0a (3-legged)** | User actions: post tweets, send DMs, manage follows | API Key + Secret + Access Token + Secret |
| **OAuth 2.0 with PKCE** | Modern user auth: same as 1.0a but with scopes and refresh tokens | Client ID + Client Secret + authorization code flow |

For most OpenZigs use cases, **OAuth 1.0a** is the simplest path for full read/write access. OAuth 2.0 with PKCE is recommended for new integrations and supports the `offline.access` scope for automatic token refresh.

**3. Set environment variables:**

```dotenv
TWITTER_BEARER_TOKEN=AAAAAAAAAAAAAAAAAAAAAAxxxxxxx
# Optional — needed for DMs, posting:
TWITTER_API_KEY=xxxxxx
TWITTER_API_SECRET=xxxxxx
TWITTER_ACCESS_TOKEN=xxxxxx
TWITTER_ACCESS_TOKEN_SECRET=xxxxxx
```

**4. Create the Python venv:**

```bash
cd external/twitter-mcp && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && deactivate
```

**5. Configure webhook (Account Activity API — Pro tier):**

The Account Activity API (Pro tier) provides real-time webhooks for mentions, DMs, and other user activity:

```bash
# Register a webhook URL
curl -X POST "https://api.x.com/2/webhooks" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-tunnel-url>/api/social/webhooks/twitter"}'

# The endpoint will respond to the CRC challenge automatically
```

**6. Alternative — Polling with X API v2 (Free/Basic tier):**

For free/basic tier without webhook support, use polling:

```json
{
  "socialBrain": {
    "connections": {
      "twitter": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 60
      }
    }
  }
}
```

The polling adapter searches for recent mentions:

```bash
curl "https://api.x.com/2/tweets/search/recent?query=@yourusername&tweet.fields=created_at,author_id" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN"
```

> **Rate limits & pricing:** X API now uses a **credit-based pay-per-usage** model with configurable spending limits. The Free tier has very limited access (~500 tweet reads/month, ~50k for Basic). Pro tier includes webhook support and higher volume. See [X API Pricing](https://docs.x.com/x-api/getting-started/pricing) for current details.

**Available Tools (8):** `twitter_post_tweet`, `twitter_send_dm`, `twitter_search_tweets`, `twitter_get_user_info`, `twitter_get_user_tweets`, `twitter_get_tweet`, `twitter_get_followers`, `twitter_get_following`

#### Twitter/X DM Requirements — Recipient Privacy Settings

For OpenZigs to successfully deliver a DM to a user on Twitter/X, **the recipient must have their account configured to accept DMs from people they don't follow.** This is controlled by the recipient, not by your app credentials.

**What the recipient must do:**

1. Open the X app or [x.com](https://x.com) and go to **Settings → Privacy and safety → Direct messages**
2. Enable **"Allow message requests from everyone"**

Without this setting, X will return a `403 Forbidden` error when OpenZigs attempts to send the DM, and the automation log will record `dm_sent = 0` with an error.

**Message Requests folder:**

Even with the correct privacy setting, DMs from users the recipient does **not** follow are placed in a **"Message requests"** folder — not the main inbox. The recipient must:

1. Open Messages on X
2. Tap **"Message requests"** at the top of the message list
3. Accept or decline the request — once accepted, future messages go directly to the main inbox

This is standard X/Twitter platform behaviour and cannot be overridden by the sender or OpenZigs.

**Summary of recipient requirements:**

| Condition | DM Delivered? | Where it Appears |
|---|---|---|
| Recipient follows you | Yes | Main inbox |
| Recipient doesn't follow you, "Allow message requests from everyone" **enabled** | Yes | Message requests folder |
| Recipient doesn't follow you, "Allow message requests from everyone" **disabled** | No | 403 error — DM not sent |

> **Troubleshooting tip:** If you see `dm_sent = 1` in the automation log but the recipient reports not receiving the DM, ask them to check their **Message requests** folder on X/Twitter. If you see `dm_sent = 0` with repeated failures, the recipient likely needs to enable the privacy setting above.

---

### TikTok (via TikNeuron — Read Only)

TikTok does not offer a public content publishing API to most developers. OpenZigs integrates TikTok through [TikNeuron](https://tikneuron.com), a third-party API that provides **read-only** access to TikTok content — search posts, get post details, and download subtitles. No OAuth or TikTok developer account is needed.

**Difficulty:** Easy | **Token Expiry:** None (API key) | **App Review:** Not required | **Pricing:** Free tier (20 credits), Pro ($7.49/mo, 500 credits), Business ($24/mo, 1,800 credits)

**1. Create a TikNeuron account:**

1. Go to [tikneuron.com/signin](https://tikneuron.com/signin).
2. Click **"Login with Google"** — Google is the only supported sign-in method.
3. Sign in with your Google account and authorize TikNeuron.
4. After signing in, you'll be redirected to the TikNeuron dashboard.

**2. Get your API key:**

1. Navigate to the [API page](https://tikneuron.com/api) — your API key is shown under **"Your API Key"** at the top of the page.
2. Copy the API key.

**3. Set environment variables:**

```dotenv
TIKNEURON_MCP_API_KEY=your_api_key_here
```

**4. Server startup:**

The TikTok MCP server is a **Node.js** server (no Python venv needed). It's pre-built at `external/tiktok-mcp/build/index.js` and starts automatically when `TIKNEURON_MCP_API_KEY` is set in your `.env`.

> **Credit costs:** Search = 1 credit, Post Details = 1 credit, Subtitles = 1 credit. The free tier includes 20 non-expiring credits. See [tikneuron.com/pricing](https://tikneuron.com/pricing) for plan details.

> **Limitation:** TikTok integration is **read-only** — you can search posts, get post details, and download subtitles, but publishing, DMs, and comment replies are not supported. To publish content on TikTok, use the TikTok Creator Tools or a third-party scheduler.

**Available Tools (3):** `tiktok_search`, `tiktok_get_post_details`, `tiktok_get_subtitle`

---

### Reddit

Reddit does not support webhooks. Use the polling adapter.

**Difficulty:** Easy | **Token Expiry:** None (auto-managed internally) | **App Review:** Not required

**1. Create a Reddit App:**

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps).
2. Scroll to the bottom and click **create another app...**.
3. Fill in the details:
   - **Name:** e.g., "OpenZigs Bot"
   - **App type:** Select **script** (this is the simplest type for server-side automation)
   - **Redirect URI:** `http://localhost:3000` (required field, not actually used for script apps)
4. Click **Create app**.
5. Note the credentials:
   - **Client ID:** The string directly under the app name (e.g., `a1b2c3d4e5f6g7`)
   - **Client Secret:** The "secret" field

**2. Set environment variables:**

```dotenv
REDDIT_CLIENT_ID=your-reddit-client-id
REDDIT_CLIENT_SECRET=your-reddit-client-secret
REDDIT_USERNAME=your-reddit-bot-username
REDDIT_PASSWORD=your-reddit-bot-password
```

The `reddit-mcp` native server handles OAuth token acquisition automatically using these credentials.

**3. Enable polling:**

```json
{
  "socialBrain": {
    "connections": {
      "reddit": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      }
    }
  }
}
```

**4. Reddit API endpoints used:**

```bash
# Get new comments on a subreddit (via polling adapter)
curl "https://oauth.reddit.com/r/YOUR_SUBREDDIT/comments?limit=25&sort=new" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "User-Agent: openzigs/1.0"

# Get inbox messages / DMs
curl "https://oauth.reddit.com/message/inbox?limit=25" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "User-Agent: openzigs/1.0"
```

> **Rate limit:** Reddit allows 60 requests per minute per OAuth token.

> **Tip:** Consider creating a separate Reddit account for your bot rather than using your personal account.

**5. Create the Python venv:**

```bash
cd external/reddit-mcp && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && deactivate
```

**Available Tools (8):** `reddit_submit_post`, `reddit_reply_to_comment`, `reddit_send_message`, `reddit_get_subreddit_posts`, `reddit_get_post_comments`, `reddit_search`, `reddit_get_inbox`, `reddit_get_user_info`

---

### LinkedIn

LinkedIn uses OAuth 2.0 (3-legged authorization code flow) for API access. OpenZigs includes a built-in OAuth flow that handles token exchange, storage, and auto-refresh.

**Difficulty:** Medium | **Token Expiry:** 60 days (auto-refreshable) | **App Review:** Required for DMs (Marketing API Partner)

#### LinkedIn OAuth Setup

**1. Create a LinkedIn App:**

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps/)
2. Create a new app and request access to:
   - **Sign In with LinkedIn using OpenID Connect** (`openid`, `profile`, `email` scopes)
   - **Share on LinkedIn** (`w_member_social` scope)
   - **Marketing Developer Platform** (optional, for organization pages and programmatic refresh tokens)
3. In the **Auth** tab, add your redirect URL:
   - Local development: `http://localhost:3000/api/linkedin/oauth/callback`
   - Production: `https://<your-domain>/api/linkedin/oauth/callback`
4. Note your **Client ID** and **Client Secret**

**2. Set app credentials** (choose one method):

*Option A — Admin UI:*
1. Navigate to **Admin → MCP Servers → LinkedIn** 
2. Enter your Client ID and Client Secret
3. Click **Connect LinkedIn** to start the OAuth flow

*Option B — Environment variables:*
```dotenv
LINKEDIN_CLIENT_ID=your-linkedin-client-id
LINKEDIN_CLIENT_SECRET=your-linkedin-client-secret
```
Then visit `GET /api/admin/linkedin/oauth/authorize` to generate the OAuth URL.

**3. Complete the OAuth flow:**

1. The authorize endpoint returns an `authUrl` — open it in a browser
2. Sign in to LinkedIn and approve the requested permissions
3. LinkedIn redirects back to your callback URL
4. OpenZigs automatically exchanges the code for access + refresh tokens
5. Tokens are saved to `.env` with `0o600` permissions

**4. Token lifecycle:**

| Token | Lifetime | Auto-Refresh |
|---|---|---|
| Access token | 60 days | Yes — refreshed when expiring within 7 days |
| Refresh token | 365 days | Extended on each use (if Marketing Developer Platform approved) |

OpenZigs checks token expiry on startup and daily. If the access token expires within 7 days, it's automatically refreshed using the stored refresh token.

**5. API endpoints:**

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/admin/linkedin/app-credentials` | POST | Save Client ID + Secret |
| `/api/admin/linkedin/oauth/authorize` | GET | Generate OAuth authorization URL |
| `/api/admin/linkedin/oauth/refresh` | POST | Manually trigger token refresh |
| `/api/admin/linkedin/oauth/disconnect` | POST | Clear all LinkedIn tokens |
| `/api/admin/linkedin/status` | GET | Check connection status + profile |
| `/api/linkedin/oauth/callback` | GET | OAuth callback (no auth required) |

> **Note:** LinkedIn heavily rate-limits API access and requires app review for production use. DM sending via the Messaging API is only available to Marketing API partners. Social Brain comment replies use the `linkedin-mcp` server's `reply-to-comment` tool.

#### LinkedIn Comment Monitoring — Community Management API

LinkedIn's comment polling works with the **"Share on LinkedIn"** product (`w_member_social` scope), but this only returns comments on your **own posts**. To monitor comments on **organization/company page posts** and access richer engagement data (likes, reactions, follower demographics), you need the **Community Management API** — which requires a **separate LinkedIn app**.

**Why a separate app?** LinkedIn's "Share on LinkedIn" and "Community Management API" products are **mutually exclusive** — you cannot add both to the same app. Since "Share on LinkedIn" provides the `w_member_social` scope needed for posting, you need a second app dedicated to Community Management.

**Setting up the Community Management API app:**

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps/) and click **Create app**.
2. Name it something like "OpenZigs Community Manager" (separate from your posting app).
3. **Important:** You must associate the app with a LinkedIn Company Page you admin.
4. Once created, go to the **Products** tab and request access to:
   - **Community Management API** — grants `r_organization_social`, `rw_organization_admin`, `w_organization_social` scopes
5. LinkedIn will review your request. Approval can take **several business days** and may require:
   - A verified company page with activity
   - A description of your use case
   - Compliance with LinkedIn's [API Terms of Use](https://legal.linkedin.com/api-terms-of-use)
6. Once approved, configure the second app's credentials in your `.env`:
   ```dotenv
   # Community Management API app (separate from posting app)
   LINKEDIN_CM_CLIENT_ID=your-community-management-client-id
   LINKEDIN_CM_CLIENT_SECRET=your-community-management-client-secret
   ```

**What Community Management API unlocks:**

| Capability | Share on LinkedIn | Community Management API |
|---|---|---|
| Post as yourself | ✅ | ❌ |
| Read your post comments | ✅ | ✅ |
| Read org page comments | ❌ | ✅ |
| Reactions/likes data | ❌ | ✅ |
| Follower demographics | ❌ | ✅ |
| Organization analytics | ❌ | ✅ |
| Post as organization | ❌ | ✅ |

> **Current limitation:** Without the Community Management API, LinkedIn polling only detects comments on personal posts. Likes and reactions are not available through the basic "Share on LinkedIn" product. If you manage a company page and need full engagement monitoring, apply for the Community Management API on a separate LinkedIn app.

**Available Tools (8):** `linkedin_create_post`, `linkedin_reply_to_comment`, `linkedin_send_message`, `linkedin_get_profile`, `linkedin_get_posts`, `linkedin_get_company_info`, `linkedin_get_connections`, `linkedin_get_messages`

---

### Pinterest

**Difficulty:** Medium | **Token Expiry:** 30 days (refresh token lasts 365 days) | **App Review:** Not required for personal sandbox

Pinterest does not support webhooks. It is a **posting and analytics** platform only — no comment monitoring or DMs.

#### Step 1 — Create a Pinterest Developer Account

1. Go to [developers.pinterest.com](https://developers.pinterest.com/) and sign in with your Pinterest account.
2. Accept the developer terms of service.

#### Step 2 — Create an App

1. Click **My apps → Create app**.
2. Enter an app name and description.
3. Note your **App ID** and **App Secret** from the app settings.

#### Step 3 — Generate an Access Token

**Method A — Token Generator (quickest):**

1. Go to the [Pinterest Token Generator](https://developers.pinterest.com/tools/access-token/).
2. Select your app and the scopes you need:
   - `boards:read` — list boards
   - `pins:read` — read pins
   - `pins:write` — create pins
3. Click **Generate Token**. Copy the token.

**Method B — OAuth 2.0 flow:**

1. Direct users to the authorize URL:
   ```
   https://www.pinterest.com/oauth/?client_id=APP_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=boards:read,pins:read,pins:write
   ```
2. Exchange the authorization code for a token:
   ```bash
   curl -X POST "https://api.pinterest.com/v5/oauth/token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=authorization_code&code=AUTH_CODE&redirect_uri=REDIRECT_URI" \
     -u "APP_ID:APP_SECRET"
   ```

#### Step 4 — Set environment variables

```dotenv
PINTEREST_ACCESS_TOKEN=pina_xxxxxxxxxxxxxxxxxxxxxxxx
# Optional — for ads analytics only:
# PINTEREST_AD_ACCOUNT_ID=123456789
```

**Rate Limits:** 300 write requests/day for sandbox apps. Production apps require app review for higher limits.

> **Note:** Pinterest tokens expire after 30 days. Refresh using the refresh token (365-day lifetime) before expiry.

---

### Facebook

Facebook supports **two ingestion modes**: polling (recommended) and webhooks.

- **Polling mode** (default): Uses the `fb-mcp` server to periodically fetch page posts and their comments. No Meta App Review or production approval is required — works in development mode.
- **Webhook mode**: Requires a published (production-approved) Meta app, App Review, a Cloudflare Tunnel, and proper `subscribed_apps` configuration. Recommended only if you have a production-approved app.

> **Recommendation:** Use polling mode unless you have a production-approved Meta app. Meta does not deliver real webhook events in development mode.

**Difficulty:** Hard | **Token Expiry:** Page tokens are permanent (when derived from a long-lived user token) | **App Review:** Not required for page owner in dev mode

#### Step 1 — Register as a Meta Developer (if not already)

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in with your Facebook account.
2. Accept the **Platform Terms** and **Developer Policies**.
3. Complete **phone verification** and **email confirmation** when prompted.

#### Step 2 — Create a Meta App

If you already created a Meta App for Instagram (above), you can reuse the same app.

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps/) → **Create App**.
2. Select **Business** as the app type.
3. Enter an app name and contact email → click **Create App**.
4. In the App Dashboard, add the **Facebook Login** and **Pages API** products.
5. Under **Use Cases → Pages API → Customize**, add these permissions:
   - `pages_show_list` — list pages you manage
   - `pages_read_engagement` — read likes, comments, shares
   - `pages_read_user_content` — required to read comments from all users (not just admins)
   - `pages_manage_posts` — create and manage posts
   - `pages_manage_engagement` — required to reply to comments
   - `pages_manage_metadata` — required for webhook subscriptions (if using webhook mode)
   - `business_management` — access business assets
6. Go to **Settings → Basic** and copy your **App ID** and **App Secret**.

#### Step 3 — Generate a Page Access Token

**Method A — Graph API Explorer (recommended for first-time setup):**

1. Go to the [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. In the **Meta App** dropdown, select your app.
3. In the **User or Page** dropdown, select **Get Page Access Token**.
4. Select the Facebook Page you want to manage.
5. Approve all the permissions listed above when prompted.
6. Click **Generate Access Token**. This gives you a **short-lived Page token** (~1 hour).

**Method B — User token → Page token (for automation):**

1. Generate a short-lived User Access Token in the Graph API Explorer.
2. Exchange it for a **long-lived User token**:
   ```bash
   curl "https://graph.facebook.com/v21.0/oauth/access_token?\
   grant_type=fb_exchange_token&\
   client_id=YOUR_APP_ID&\
   client_secret=YOUR_APP_SECRET&\
   fb_exchange_token=YOUR_SHORT_LIVED_USER_TOKEN"
   ```
3. Use the long-lived user token to get a **permanent Page token**:
   ```bash
   curl "https://graph.facebook.com/me/accounts?access_token=YOUR_LONG_LIVED_USER_TOKEN"
   ```
   The response contains a list of pages you manage. Each entry includes:
   - `name` — Page name
   - `access_token` — **Page token** (permanent when derived from a long-lived user token)
   - `id` — Page ID
4. Copy the `access_token` and `id` for your target page.

> **Important:** Page tokens derived from a long-lived user token **do not expire** under normal conditions. They only become invalid if the user who generated them loses admin access to the page or changes their Facebook password.

#### Step 4 — Set environment variables

```dotenv
FACEBOOK_APP_ID=123456789012345
FACEBOOK_APP_SECRET=abcdef1234567890abcdef1234567890
FACEBOOK_PAGE_TOKEN=EAAL...your-page-token...
FACEBOOK_PAGE_ID=955369944333833
```

#### Step 5 — Create the Python venv

```bash
cd external/fb-mcp && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && deactivate
```

#### Step 6 — Configure polling mode (recommended)

```json
{
  "socialBrain": {
    "connections": {
      "facebook": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      }
    }
  }
}
```

Or use the mode dropdown on the **Settings** tab in the Social Brain UI.

#### (Optional) Configure Webhook Mode

Only use this if your Meta app is published and approved:

1. In the Meta App Dashboard, go to **Webhooks → Page**
2. Set the callback URL: `https://your-domain.com/api/social/webhooks/facebook`
3. Set the verify token to the value of `SOCIAL_WEBHOOK_VERIFY_TOKEN`
4. Subscribe to the `feed` field
5. In config, set `"mode": "webhook"` for Facebook

#### How Polling Works

The Facebook polling adapter:
1. Fetches recent page posts via `fb_get_page_posts`
2. For each post, fetches comments via `fb_get_post_comments`
3. Filters to comments newer than the last poll timestamp
4. Skips comments authored by the page itself
5. Delivers each new comment as an `IncomingComment` to the Social Brain pipeline

This captures all comments from any user on your page posts — not just page admins or app testers.

> **Privacy note (Graph API v24.0+):** Facebook no longer returns `from.id` for regular user comments due to privacy restrictions. The polling adapter automatically skips comments without user IDs — public comment replies still work via `fb_reply_to_comment`, but private DMs to anonymous commenters are not possible.

**Available Tools (10):** `fb_get_page_info`, `fb_get_page_posts`, `fb_get_post_insights`, `fb_publish_post`, `fb_get_conversations`, `fb_get_conversation_messages`, `fb_send_message`, `fb_get_page_insights`, `fb_get_post_comments`, `fb_reply_to_comment`

---

### Instagram

Instagram uses the Meta Graph API. It supports **two ingestion modes**: polling (recommended) and webhooks.

- **Polling mode** (default): Uses the `ig-mcp` server to periodically fetch media posts and their comments. No Meta App Review or production approval is required — works in development mode.
- **Webhook mode**: Requires a published (production-approved) Meta app, App Review, and proper webhook subscriptions. Recommended only if you have a production-approved app.

> **Recommendation:** Use polling mode unless you have a production-approved Meta app. Meta does not deliver real webhook events in development mode.

**Difficulty:** Hard | **Token Expiry:** 60 days (must be refreshed) | **App Review:** Required for DMs and Advanced Access

#### Prerequisites

- An **Instagram Professional Account** (Business or Creator) — free to switch in the Instagram app
- A **Facebook Page** connected to that Instagram account
- A **Meta Developer Account** at [developers.facebook.com](https://developers.facebook.com)

#### Step 1 — Switch Instagram to Professional Account

1. Open the Instagram app → go to your **Profile**.
2. Tap the **hamburger menu** (☰) → **Settings and privacy**.
3. Scroll to **Account type and tools** → **Switch to professional account**.
4. Choose a category (e.g., "Software Company", "Digital Creator") and select **Business** or **Creator**.
5. Complete the setup prompts. Your account is now a Professional account.

#### Step 2 — Create a Facebook Page (if you don't have one)

1. Go to [facebook.com/pages/create](https://www.facebook.com/pages/create).
2. Enter a **Page name** and **category** → Click **Create Page**.
3. You can customize the page later — the minimum is just a name and category.

#### Step 3 — Link Instagram to Your Facebook Page

1. Go to your Facebook Page → click **Settings** (gear icon or "Manage" → "Settings").
2. Navigate to **Linked accounts** (or **Instagram** in the left sidebar).
3. Click **Connect account** → log into Instagram and authorize the connection.
4. Alternatively, go to [business.facebook.com](https://business.facebook.com) → your business portfolio → **Settings → Instagram accounts** → **Connect Instagram**.

#### Step 4 — Create a Meta App

If you already created a Meta App for Facebook (above), you can reuse the same app. Otherwise:

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**.
2. Select **Business** as the app type.
3. Enter an app name and contact email → Click **Create App**.
4. In the App Dashboard, click **Add Product** → find **Instagram Graph API** → Click **Set Up**.
5. Go to **Settings → Basic** and copy:
   - **App ID** → this is your `FACEBOOK_APP_ID`
   - **App Secret** (click "Show") → this is your `FACEBOOK_APP_SECRET`
6. Under **Use Cases**, ensure you have requested these permissions:
   - `instagram_basic` — read profile info and media
   - `instagram_manage_comments` — read and reply to comments
   - `instagram_manage_messages` — DM access (requires Advanced Access via App Review)
   - `pages_show_list` — list pages you manage
   - `pages_read_engagement` — read page engagement data

> **New scope names (2025):** Meta is migrating to new scope names: `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, `instagram_business_content_publish`. Both old and new scope names currently work, but plan to migrate to the new names.

#### Step 5 — Generate an Access Token

1. Go to the [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. In the **Meta App** dropdown, select your app.
3. Click **Generate Access Token** → approve the requested permissions (select all the Instagram and Pages permissions listed above).
4. Copy the **short-lived token** from the Access Token field. This token expires in ~1 hour.

**Exchange for a long-lived token (lasts 60 days):**

```bash
curl "https://graph.facebook.com/v21.0/oauth/access_token?\
grant_type=fb_exchange_token&\
client_id=YOUR_APP_ID&\
client_secret=YOUR_APP_SECRET&\
fb_exchange_token=YOUR_SHORT_LIVED_TOKEN"
```

The response contains your long-lived `access_token` and `expires_in` (seconds). Copy the `access_token` value.

#### Step 6 — Get Your Instagram Business Account ID

```bash
# First, get your Page ID and Page Token
curl "https://graph.facebook.com/me/accounts?access_token=YOUR_LONG_LIVED_TOKEN"

# Then get the Instagram Business Account ID linked to your Page
curl "https://graph.facebook.com/YOUR_PAGE_ID?fields=instagram_business_account&access_token=YOUR_LONG_LIVED_TOKEN"
```

The response will include `instagram_business_account.id` — this is your `INSTAGRAM_BUSINESS_ACCOUNT_ID`.

#### Step 7 — Set environment variables

```dotenv
FACEBOOK_APP_ID=123456789012345
FACEBOOK_APP_SECRET=abcdef1234567890abcdef1234567890
INSTAGRAM_ACCESS_TOKEN=EAAL...your-long-lived-token...
INSTAGRAM_BUSINESS_ACCOUNT_ID=17841400000000000
```

#### Step 8 — Create the Python venv

```bash
cd external/ig-mcp && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && deactivate
```

#### Step 9 — Configure polling mode (recommended)

```json
{
  "socialBrain": {
    "connections": {
      "instagram": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      }
    }
  }
}
```

Or use the mode dropdown on the **Settings** tab in the Social Brain UI.

#### Token Refresh

Long-lived tokens expire after **60 days**. Refresh before expiry:

```bash
curl "https://graph.facebook.com/v21.0/oauth/access_token?\
grant_type=fb_exchange_token&\
client_id=YOUR_APP_ID&\
client_secret=YOUR_APP_SECRET&\
fb_exchange_token=YOUR_CURRENT_LONG_LIVED_TOKEN"
```

> **Tip:** Set a calendar reminder to refresh your Instagram token every 50 days to avoid service interruption.

#### How Polling Works

The Instagram polling adapter:
1. Fetches recent media posts via `get_media_posts`
2. Skips posts with zero comments to minimize API calls
3. For each post with comments, fetches comments via `get_media_comments`
4. Filters to comments newer than the last poll timestamp
5. Skips comments authored by the business account itself
6. Delivers each new comment as an `IncomingComment` to the Social Brain pipeline

This captures all comments from any user on your Instagram posts — not just app admins or testers.

#### (Optional) Webhook Mode

Only use this if your Meta app is published and approved:

1. In the Meta App Dashboard, go to **Webhooks → Instagram**
2. Set the callback URL: `https://your-domain.com/api/social/webhooks/instagram`
3. Set the verify token to `SOCIAL_WEBHOOK_VERIFY_TOKEN`
4. Subscribe to `comments` and `messages` fields
5. In config, set `"mode": "webhook"` for Instagram

```json
{
  "socialBrain": {
    "connections": {
      "instagram": {
        "enabled": true,
        "mode": "webhook"
      }
    }
  }
}
```

> **Note:** Instagram webhooks have the same Meta App Review requirement as Facebook. If your app is in development mode, use polling mode instead.

**Rate Limits:** 4,800 × number of impressions API calls per 24 hours. Publishing limited to **25 posts/day**.

**Available Tools (12):** `get_profile_info`, `get_media_posts`, `get_media_insights`, `publish_media`, `get_account_pages`, `get_account_insights`, `validate_access_token`, `get_conversations`, `get_conversation_messages`, `reply_to_comment`, `get_media_comments`, `send_dm`

---

## Settings Tab — Connection Status

Navigate to `/social` and click the **Settings** tab to see platform connection status at a glance:

| Status | Meaning |
|---|---|
| **Connected** (green) | Access token is configured and adapter is registered |
| **Token Set — Not Enabled** (yellow) | Token is present but platform is not enabled in config |
| **Not Configured** (gray) | No access token found |

Each platform card shows:
- The required environment variable name(s)
- The webhook endpoint path (where applicable)
- The ingestion mode (webhook vs polling)
- A link to the platform's developer documentation

For platforms that support both modes (Facebook, Twitter, Instagram), a **mode dropdown** appears on the card. Selecting a new mode saves it to config immediately. A server restart is required for the change to take effect.

---

## CRM Usage Guide

### Contacts

Every user who sends a DM or comment is automatically added to the CRM. Contact records include:

| Field | Description |
|---|---|
| `username` | Platform username |
| `display_name` | Full name (if available) |
| `platform` | Source platform (`instagram`, `facebook`, `twitter`, `youtube`, `linkedin`, `reddit`) |
| `tags` | JSON array of tags for segmentation |
| `notes` | Free-text CRM notes |
| `message_count` | Total messages exchanged |
| `handoff_active` | Whether a human handoff is in progress |
| `handoff_thread_id` | Discord/Telegram thread ID (if handoff active) |

### Searching and Filtering

Use the CRM tab to:
- **Search** by username, display name, or notes
- **Filter by platform** via the dropdown
- **Click a contact** to open the detail drawer with message history, tagging, and notes

### Tagging

Tags enable segmentation and follow-up workflows:

```bash
# Add a tag via API
curl -X POST http://localhost:3000/api/social/contacts/<id>/tags \
  -H "Content-Type: application/json" \
  -d '{"tag": "high-value"}'

# Or use the MCP tool in chat:
# "Tag contact abc123 as 'vip'"
```

Automation rules can auto-tag contacts when they trigger a keyword match (via `auto_tag` field).

### CSV Export

```bash
curl http://localhost:3000/api/social/contacts/export -o contacts.csv
```

---

## Automation Rules (Comment-to-DM)

### Creating a Rule

Navigate to `/social` → **Automations** tab → **+ New Rule**:

| Field | Description |
|---|---|
| **Name** | Display name (e.g., "Pricing Interest") |
| **Platform** | Target platform (`instagram`, `facebook`, `twitter`, `youtube`, `linkedin`, `reddit`) |
| **Keywords** | Comma-separated trigger words (case-insensitive, word-boundary match) |
| **Regex** | Alternative to keywords — advanced pattern matching |
| **Post IDs** | (Optional) Scope rule to specific post/video IDs |
| **DM Template** | Message to send as DM, with variable interpolation |
| **Comment Reply** | (Optional) Public reply to the comment |
| **DM Delay** | Seconds to wait before sending the DM |
| **Max per User** | Maximum times a single user can trigger this rule |
| **Max Total** | Maximum times the rule fires across all users |
| **Auto-Tag** | Tag to apply to contacts who trigger the rule |

### Template Variables

| Variable | Description |
|---|---|
| `{{username}}` | The commenter's username |
| `{{keyword}}` | The keyword that triggered the rule |
| `{{post_id}}` | The platform media/post ID |
| `{{comment_text}}` | The full comment text |
| `{{post_caption}}` | The post's caption (requires platform access token) |
| `{{post_url}}` | The post's permalink (requires platform access token) |

### Example Rules

**Lead Capture:**
```
Name: Pricing Interest
Platform: instagram
Keywords: interested, pricing, price, how much, cost
DM Template: Hey {{username}}! Thanks for your interest in {{post_caption}}. Here's a link to our pricing: https://example.com/pricing
Comment Reply: Thanks for asking! Check your DMs 📬
Auto-Tag: lead
```

**YouTube Comment Reply (No DM — YouTube doesn't support DMs):**
```
Name: YouTube FAQ
Platform: youtube
Keywords: how to, tutorial, help
Comment Reply: Check the description for the full tutorial! 🎥
Max per User: 2
```

**Cross-Platform Free Resource:**
```
Name: Free Guide
Platform: instagram
Keywords: free, guide, download, ebook
DM Template: Hey {{username}}! Here's your free guide: https://example.com/guide. Enjoy!
DM Delay: 5
Max per User: 1
```

### Via API

```bash
# Create a rule
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pricing Interest",
    "platform": "instagram",
    "keywords": "[\"interested\", \"pricing\", \"cost\"]",
    "dm_template": "Hey {{username}}! Thanks for asking about {{post_caption}}. Check out https://example.com/pricing",
    "comment_reply_template": "Thanks! Check your DMs 📬",
    "dm_delay_seconds": 3,
    "max_triggers_per_user": 1,
    "auto_tag": "lead"
  }'

# List rules
curl http://localhost:3000/api/social/rules | python3 -m json.tool

# Enable/disable a rule
curl -X PATCH http://localhost:3000/api/social/rules/<id> \
  -H "Content-Type: application/json" \
  -d '{"enabled": 0}'

# Delete a rule
curl -X DELETE http://localhost:3000/api/social/rules/<id>

# View automation log
curl "http://localhost:3000/api/social/rules/log?limit=25" | python3 -m json.tool
```

---

## AI Rule Generation

Instead of manually configuring keywords, templates, and settings, you can describe what you want in plain English and let the AI generate a complete automation rule.

### Using the UI

1. Navigate to `/social` → **Automations** tab
2. Click the **AI Generate** button (sparkle icon)
3. Enter a description, e.g., _"Capture leads who comment about pricing on Instagram"_
4. Optionally select a target platform and model
5. Click **Generate**
6. Review the generated rule — edit any fields if needed
7. Click **Save** to create the rule

### Using the API

```bash
curl -X POST http://localhost:3000/api/social/rules/generate \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Welcome everyone who asks about our product on Twitter",
    "platform": "twitter"
  }'
```

**Response:**

```json
{
  "rule": {
    "name": "Product Welcome",
    "platform": "twitter",
    "keywords": "[\"product\", \"interested\", \"tell me more\", \"info\"]",
    "dm_template": "Hey {{username}}! Thanks for your interest in our product. Here is everything you need to know: ...",
    "comment_reply_template": "Thanks for asking, {{username}}! Check your DMs 📬",
    "auto_tag": "product-interest",
    "max_triggers_per_user": 1
  }
}
```

The `platform` parameter is optional — if omitted, the AI defaults to Instagram. The generated rule includes all standard fields (`name`, `keywords`, `dm_template`, `comment_reply_template`, `auto_tag`, `max_triggers_per_user`) ready to be saved via `POST /api/social/rules`.

> **Requires:** Copilot SDK authentication. If the SDK is not connected, the endpoint returns HTTP 503.

---

## Follow-Up Sequences

Follow-up sequences send timed DM messages after an automation rule triggers. This is useful for nurture campaigns — e.g., send a pricing link immediately, then follow up 1 hour later with a case study, and 24 hours later with a trial reminder.

### Creating Follow-Up Steps via UI

1. Navigate to `/social` → **Automations** tab
2. Click any rule to expand its details
3. The **Follow-Up Steps** section appears below the rule
4. Click **+ Add Step** to create a new step
5. Set the **delay** (in seconds) and **message template**
6. Steps execute in order — step 0 fires first, then step 1, etc.

### Creating Follow-Up Steps via API

```bash
# Add a 1-hour follow-up
curl -X POST http://localhost:3000/api/social/rules/<ruleId>/follow-ups \
  -H "Content-Type: application/json" \
  -d '{
    "stepOrder": 0,
    "delaySeconds": 3600,
    "messageTemplate": "Hey {{username}}, just following up — any questions about pricing?"
  }'

# Add a 24-hour follow-up
curl -X POST http://localhost:3000/api/social/rules/<ruleId>/follow-ups \
  -H "Content-Type: application/json" \
  -d '{
    "stepOrder": 1,
    "delaySeconds": 86400,
    "messageTemplate": "Hi {{username}}, last reminder — our free trial ends soon!"
  }'

# List steps for a rule
curl http://localhost:3000/api/social/rules/<ruleId>/follow-ups

# Delete a step
curl -X DELETE http://localhost:3000/api/social/rules/<ruleId>/follow-ups/<stepId>
```

### How It Works

When a rule triggers, the `FollowUpScheduler` creates pending jobs for each follow-up step. The scheduler runs on a cron interval and dispatches DMs when the delay has elapsed. If a DM fails, the job is marked as errored and the scheduler continues with the next step.

---

## AI Auto-Reply (Brain Engine)

The Brain Engine processes incoming DMs through a RAG pipeline:

1. **Knowledge search** — Searches your local knowledge base for relevant documents
2. **Conversation history** — Loads the last 5 messages for context
3. **Post context** — If the message relates to a comment, includes the post's caption and URL
4. **Platform tone** — System prompt is platform-aware (formal for LinkedIn, casual for Instagram/Reddit)
5. **LLM call** — Sends everything to the model with a social-media-specific system prompt
6. **Confidence routing:**
   - **High confidence** → auto-sends the reply via `DmDispatcher`
   - **Medium confidence** → auto-sends (configurable via `confidenceThreshold`)
   - **Low confidence** → escalates to human handoff

### Configure Confidence Threshold

```json
{
  "socialBrain": {
    "confidenceThreshold": "medium"
  }
}
```

| Value | Behavior |
|---|---|
| `high` | Only auto-reply when the AI is very confident; escalate medium and low |
| `medium` | Auto-reply for high and medium confidence; escalate low (default) |
| `low` | Auto-reply for everything; only escalate explicit handoff requests |

### Knowledge Base Integration

The Brain Engine uses the same knowledge base as the main chat. Add documents to your knowledge directory:

```bash
# Add product FAQ to knowledge base
cp product-faq.md ~/.openzigs/knowledge/

# The knowledge service auto-indexes new files (if watchEnabled: true)
```

When a customer asks "What's your return policy?", the Brain searches the knowledge base, finds the relevant FAQ section, and generates a reply using that context.

---

## AI Comment Replies

By default, the Brain Engine only processes DMs. You can enable **AI Comment Replies** to also route public comments through the Brain when no keyword automation rule matches.

### Configuration

Enable via the Settings tab on the Social Brain page, or through the config file:

```json
{
  "socialBrain": {
    "commentBrainEnabled": true
  }
}
```

When enabled:
1. An incoming comment is first evaluated by the **Comment Rule Engine** (keyword automation)
2. If no rules match, the comment is sent to the Brain Engine
3. The Brain generates a public-appropriate reply using RAG context + post caption
4. The reply is stored as an outbound message (either auto-sent or held for approval)

### API

```bash
# Toggle via admin API
curl -X POST http://localhost:3000/api/admin/social-brain/settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commentBrainEnabled": true}'
```

---

## Approval Queue

When **Require Approval** is enabled, all AI-generated replies (both DM and comment) are held in a pending state for human review before being sent.

### Configuration

Enable via the Settings tab or config:

```json
{
  "socialBrain": {
    "approvalRequired": true
  }
}
```

### Workflow

1. Brain Engine generates a reply → message is stored with `status: "pending_approval"`
2. A real-time `social:pending_approval` Socket.IO event notifies the UI
3. The **Activity tab** shows a "Pending Approval" section at the top with orange-highlighted cards
4. For each pending reply, you can:
   - **Approve** — sends the reply as-is
   - **Edit & Approve** — modify the reply content, then send
   - **Reject** — discards the reply (status changes to `rejected`)

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/social/approvals` | List all pending approval messages |
| `GET` | `/api/social/approvals/count` | Get pending count (for badge display) |
| `POST` | `/api/social/approvals/:id/approve` | Approve a pending reply |
| `POST` | `/api/social/approvals/:id/reject` | Reject a pending reply |
| `POST` | `/api/social/approvals/:id/edit` | Edit content and approve |

---

## Manual Reply (Compose UI)

You can send manual replies directly from the CRM contact detail panel:

1. Click on a contact in the CRM tab
2. Scroll to the bottom of the messages list
3. Type your reply in the "Type a reply..." input
4. Click **Send** or press Enter

Manual replies are stored with `source: "manual_reply"` metadata and sent via `DmDispatcher`.

### API

```bash
curl -X POST http://localhost:3000/api/social/contacts/$CONTACT_ID/reply \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Thanks for reaching out!"}'
```

---

## Voice Learning (Episodic Memory)

Social Brain **learns your voice** from every reply you approve or edit. Approved replies are stored as episodic memory (few-shot examples) and retrieved at generation time to match your tone and style.

### How It Works

1. You approve or edit-and-approve a pending reply (via the web UI or Telegram inline buttons)
2. The original inbound message + your approved reply are stored as a **voice example** in the knowledge base (`category: "voice_example"`, `visibility: "internal"`)
3. On the next reply generation, Social Brain retrieves the **3 most semantically similar** past examples via hybrid search (vector + full-text)
4. These examples are injected into the prompt as few-shot context:

```
Previously approved replies (match this style and tone):

Example 1:
  User said: How much does your starter plan cost?
  You replied: Hey! Our starter plan is $29/mo. Want me to send the full breakdown?

Example 2:
  User said: Do you offer discounts for teams?
  You replied: Absolutely! Teams of 5+ get 20% off. DM me your team size and I'll get you a quote.
```

5. The LLM uses these examples to match your phrasing, tone, emoji usage, and response length

### Progressive Improvement

- **0 examples** — Brain uses brand voice settings + knowledge base only
- **1–5 examples** — Early patterns emerge (formality level, greeting style)
- **10+ examples** — Replies closely match your natural voice
- **Edited replies are especially valuable** — they teach the AI where its defaults don't match your style

### Storage Details

| Aspect | Value |
|--------|-------|
| Category | `voice_example` |
| Visibility | `internal` (excluded from public RAG search) |
| Document ID | `voice-example-{messageId}` |
| Retrieval | Hybrid search (vector + FTS), top 3 by similarity |
| Search scope | Filtered to `categories: ["voice_example"]` only |

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/social/voice-learning/stats` | Example count and enabled status |
| `DELETE` | `/api/social/voice-learning/examples` | Clear all stored voice examples (reset) |

### Telegram Integration

When using Telegram inline approve/reject buttons, approved replies are recorded as voice examples automatically — no web UI interaction required.

---

## Push Notifications

Real-time push notifications alert you to new messages, comments, and pending approvals across configured channels.

### Configuration

Enable via the Settings tab or config:

```json
{
  "socialBrain": {
    "notifications": {
      "enabled": true,
      "telegram": true,
      "discord": true,
      "web": true
    }
  }
}
```

### Channels

| Channel | Requirement | Event |
|---------|-------------|-------|
| **Web** (Socket.IO) | Always available | `social:new_message`, `social:new_comment`, `social:pending_approval` |
| **Telegram** | Bot token + admin chat ID configured | Sends formatted alert to the admin chat |
| **Discord** | Bot token + notification channel ID | Sends formatted alert to the notification channel |

### Socket.IO Events

| Event | Payload | Description |
|-------|---------|-------------|
| `social:new_message` | `{ contact, message }` | New inbound DM received |
| `social:new_comment` | `{ comment }` | New inbound comment received |
| `social:pending_approval` | `{ contact, message, result }` | AI reply held for approval |
| `social:comment_reply` | `{ contact, comment, result }` | AI auto-replied to a comment |

---

## Human Handoff

When the AI cannot answer confidently, the conversation is escalated to a human operator:

### Configuration

```json
{
  "socialBrain": {
    "handoff": {
      "preferredChannel": "discord",
      "discordChannelId": "1234567890",
      "autoArchiveMinutes": 60
    }
  }
}
```

### Flow

1. Brain Engine returns `confidence: "low"` (or below the configured threshold)
2. Handoff Manager creates a thread in the configured Discord/Telegram channel
3. Contact's CRM record is updated: `handoff_active: 1`, `handoff_thread_id: "..."`, `handoff_channel: "discord"`
4. The contact detail drawer shows an orange "Handoff Active" banner
5. Admin replies in the Discord/Telegram thread are forwarded back to the user (via `DmDispatcher`)
6. Close the handoff from the CRM or via the `social-close-handoff` MCP tool

### Close via API

```bash
curl -X POST http://localhost:3000/api/social/handoff/<contactId>/close \
  -H "Content-Type: application/json" \
  -d '{"resolution": "Issue resolved — refund processed"}'
```

---

## Leads Tab

The Leads tab at `/social` → **Leads** shows contacts who have shared their email address or phone number in a DM conversation. Lead capture happens automatically — the `LeadCaptureService` scans incoming DM text for email and phone patterns.

### How It Works

1. A user sends a DM containing an email (e.g., `buyer@example.com`) or phone number (e.g., `555-123-4567`)
2. The `LeadCaptureService` extracts the data and updates the contact record
3. The contact's `lead_captured_at` timestamp is set
4. The contact now appears on the Leads tab

### UI Features

- **Platform filter** — Filter leads by source platform (Instagram, Facebook, Twitter, etc.)
- **Table columns** — Username, platform, email, phone, captured date
- **Empty state** — Shows "No leads captured yet" when no leads exist

### Via API

```bash
# All leads
curl http://localhost:3000/api/social/leads

# Filter by platform
curl "http://localhost:3000/api/social/leads?platform=instagram"
```

---

## Analytics Tab

The Analytics tab at `/social` → **Analytics** shows conversation and automation statistics across all connected platforms.

### Summary Cards

| Card | Description |
|------|-------------|
| **Total Conversations** | Unique contacts who have exchanged messages |
| **Total Messages** | All inbound + outbound messages |
| **Automations Fired** | Total automation rule triggers |
| **Active Contacts** | Contacts with recent activity |

### Per-Platform Breakdown

A table showing per-platform stats: message count, contact count, and automation trigger count. This helps identify which platforms are driving the most engagement.

### Via API

```bash
# Full analytics
curl http://localhost:3000/api/social/analytics

# Filtered by date
curl "http://localhost:3000/api/social/analytics?since=2026-03-01T00:00:00Z"
```

---

## MCP Tools (Chat Interface)

### Social CRM Tools

5 Social Brain CRM tools are available in the chat interface regardless of which platforms are connected:

| Tool | Risk | Description |
|---|---|---|
| `social-crm-lookup` | 🟢 low | Search CRM contacts by username, platform, tag, or free text |
| `social-crm-history` | 🟢 low | Get message history for a contact |
| `social-crm-tag` | 🟢 low | Add a tag to a contact |
| `social-close-handoff` | 🟡 medium | Close an active human handoff |
| `social-brain-stats` | 🟢 low | Get dashboard statistics |

### Platform-Specific Tools

Each connected native MCP server exposes platform-specific tools. These are available in the chat interface when the corresponding server is running:

**Instagram (`ig-mcp`) — 11 tools:**
- `get_profile_info` — Business profile info (followers, bio)
- `get_media_posts` — Recent posts with engagement metrics
- `get_media_insights` — Per-post analytics (reach, likes, shares)
- `publish_media` — **Publish image/video with caption** (requires publicly-accessible media URL)
- `get_account_pages` — List connected Facebook pages
- `get_account_insights` — Account-level analytics
- `get_conversations` — List DM conversations
- `get_conversation_messages` — Read DM thread messages
- `send_dm` — Send Instagram DM (24h window, Advanced Access required)
- `reply_to_comment` — Reply to a comment on a post
- `get_media_comments` — Get comments on a media post

**Facebook (`fb-mcp`) — 10 tools:**
- `fb_get_page_info` — Page profile (name, followers, category)
- `fb_get_page_posts` — Recent posts with engagement
- `fb_get_post_insights` — Per-post analytics
- `fb_publish_post` — **Publish text/link post to the page feed**
- `fb_get_conversations` — List Messenger conversations
- `fb_get_conversation_messages` — Read conversation messages
- `fb_send_message` — Send Messenger reply (24h window)
- `fb_get_page_insights` — Page-level analytics
- `fb_get_post_comments` — Get comments on a page post
- `fb_reply_to_comment` — Reply to a comment on a page post

**Twitter/X (`twitter-mcp`) — 8 tools:**
- `twitter_get_me` — Authenticated user profile
- `twitter_get_user_tweets` — Recent tweets from a user
- `twitter_search_tweets` — Search recent tweets
- `twitter_get_tweet` — Get tweet by ID (with conversation context)
- `twitter_post_tweet` — **Post a new tweet** or reply to an existing tweet (with `reply_to` param)
- `twitter_get_dm_events` — Get recent DM events
- `twitter_send_dm` — Send a direct message
- `twitter_get_user` — Look up user by username

**YouTube (`youtube-mcp`) — 8 tools:**
- `yt_get_channel_info` — Channel info (subscribers, views)
- `yt_get_channel_videos` — List channel videos
- `yt_get_video_details` — Video details (stats, duration)
- `yt_get_video_comments` — Get comment threads on a video
- `yt_reply_to_comment` — Reply to a YouTube comment (requires OAuth)
- `yt_search_videos` — Search YouTube videos
- `yt_get_channel_analytics` — Channel statistics
- `yt_upload_video` — **Upload a video file to YouTube** (resumable upload, requires OAuth with `youtube.upload` scope, costs 1600 quota units)

**LinkedIn (`linkedin-mcp`) — 8 tools:**
- `linkedin_get_profile` — Authenticated user profile
- `linkedin_get_posts` — Recent posts (personal or company)
- `linkedin_create_post` — **Publish a text post** (PUBLIC or CONNECTIONS visibility)
- `linkedin_get_company` — Company/organization page info
- `linkedin_send_message` — Send a LinkedIn message (partner-only API)
- `linkedin_get_conversations` — List message conversations
- `linkedin_get_post_comments` — Get comments on a post
- `linkedin_reply_to_comment` — Reply to a comment on a post

**Reddit (`reddit-mcp`) — 8 tools:**
- `reddit_get_me` — Authenticated user profile
- `reddit_get_subreddit_posts` — Posts from a subreddit (hot/new/top/rising)
- `reddit_get_post_comments` — Comments on a post
- `reddit_submit_post` — **Submit a new text or link post** to a subreddit
- `reddit_reply_to_comment` — Reply to a comment or post
- `reddit_search` — Search Reddit posts
- `reddit_get_inbox` — Inbox messages
- `reddit_send_message` — Send a private message

**Example chat prompts:**

```
Look up all Instagram contacts tagged "lead"

Show me the message history for contact abc123

What are the current Social Brain stats?

List the 10 most recent comments on our YouTube channel

Search Twitter for recent mentions of our brand

Reply to Instagram comment 123 with "Thanks for your feedback!"
```

---

## Posting to Social Media

Social Brain isn't just for inbound messages — you can **publish content to any connected platform** directly from the chat interface. Each platform's native MCP server includes a posting/publishing tool.

### Platform Posting Capabilities

| Platform | Tool | Content Types | Limitations |
|---|---|---|---|
| **Instagram** | `instagram-publish-media` | Image, video (Reels) with caption | Requires publicly-accessible media URL; caption-only posts not supported (must include image/video) |
| **Facebook** | `facebook-publish-post` | Text post, text + link | Text required; optional link attachment. Photos/videos require separate Graph API upload |
| **Twitter/X** | `twitter-post-tweet` | Text (280 chars) | Can also reply to tweets via `reply_to` parameter. Media upload not yet supported in MCP server |
| **LinkedIn** | `linkedin-create-post` | Text post (PUBLIC or CONNECTIONS) | Max 3,000 characters. Image/video posts require separate LinkedIn upload API (not yet in MCP server) |
| **Reddit** | `reddit-submit-post` | Text (self) post or link post | Requires `subreddit` and `title`. Text and URL are mutually exclusive |
| **YouTube** | `youtube-upload-video` | Video file upload (resumable) with title, description, tags, category, privacy | Costs **1,600 quota units** per upload (~6/day with default 10k daily quota). File must exist on server disk. Requires OAuth2 with `youtube.upload` scope. Defaults to **private** |

### How to Post from Chat

Simply ask the agent to post content. The agent automatically selects the correct platform-specific tool:

```
You: Post "Just launched our new product! Check it out at https://example.com 🚀" to LinkedIn
Agent: [calls linkedin-create-post with text="Just launched..." visibility="PUBLIC"]
✅ Posted to LinkedIn

You: Publish an Instagram Reel with this video https://cdn.example.com/reel.mp4 and caption "Behind the scenes 🎬"
Agent: [calls instagram-publish-media with video_url="https://cdn..." caption="Behind the scenes 🎬"]
✅ Published to Instagram

You: Tweet "We're hiring! Apply at https://example.com/careers"
Agent: [calls twitter-post-tweet with text="We're hiring!..."]
✅ Posted to Twitter/X

You: Submit a post to r/startups titled "Show HN: Our AI-powered social media tool" with a link to our site
Agent: [calls reddit-submit-post with subreddit="startups" title="Show HN:..." url="https://example.com"]
✅ Submitted to r/startups

You: Post "Big announcement coming tomorrow! Stay tuned 👀" to our Facebook Page
Agent: [calls facebook-publish-post with message="Big announcement..."]
✅ Posted to Facebook Page

You: Upload the video at /home/user/renders/demo.mp4 to YouTube titled "Product Demo v2" with tags ["demo", "walkthrough"] and set it to unlisted
Agent: [calls youtube-upload-video with file_path="/home/user/renders/demo.mp4" title="Product Demo v2" tags=["demo","walkthrough"] privacy_status="unlisted"]
✅ Uploaded to YouTube (video ID: dQw4w9WgXcQ, privacy: unlisted)
```

### Cross-Platform Posting

You can ask the agent to post the same content to multiple platforms in one request:

```
You: Post "We just raised our Series A! 🎉 Read more: https://example.com/news" to LinkedIn, Twitter, and Facebook
Agent: [calls linkedin-create-post] ✅ Posted to LinkedIn
       [calls twitter-post-tweet] ✅ Posted to Twitter/X (truncated to 280 chars if needed)
       [calls facebook-publish-post] ✅ Posted to Facebook Page
```

> **Markdown conversion:** When posting via the legacy `social-post` tool, Markdown is automatically converted to platform-safe Unicode text (`**bold**` → **bold**, `*italic*` → *italic*). The per-platform tools accept plain text directly.

### Required Credentials for Posting

| Platform | Required Env Vars | API Permissions |
|---|---|---|
| Instagram | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` |
| Facebook | `FACEBOOK_PAGE_TOKEN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | `pages_manage_posts`, `pages_read_engagement` |
| Twitter/X | `TWITTER_BEARER_TOKEN`, `TWITTER_API_KEY`, `TWITTER_API_SECRET` | OAuth 1.0a with `tweet.write` scope; Free tier: 500 tweets/month |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` | `w_member_social` (personal) or `w_organization_social` (company page) |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` | OAuth2 script app; 100 requests/minute |

> **Note:** Instagram publishing requires a Professional account (Business or Creator) and a connected Facebook Page. The media URL must be publicly accessible — Instagram fetches the image/video from the URL during the container creation step.

---

## Native MCP Server Configuration

All social MCP servers are configured via the Admin UI under **Local MCP Servers**. Navigate to `/admin` to access this panel.

The Docker "MCP Sidecars" panel has been removed — all servers are now native subprocesses.

### Required Credentials per Server

| Server | Required Environment Variables |
|--------|-------------------------------|
| Instagram | `INSTAGRAM_ACCESS_TOKEN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `INSTAGRAM_BUSINESS_ACCOUNT_ID` |
| Facebook | `FACEBOOK_PAGE_TOKEN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| Twitter/X | `TWITTER_BEARER_TOKEN`, `TWITTER_API_KEY`, `TWITTER_API_SECRET` |
| YouTube | `YOUTUBE_API_KEY`, `YOUTUBE_OAUTH_TOKEN` (required for uploads and comment replies) |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` |
| Reddit | *(configured via Reddit OAuth in `reddit-mcp` settings)* |
| Gmail | `GOOGLE_OAUTH_CREDENTIALS` |
| GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| Database | `JDBC_URL`, `DB_PASSWORD` |

Set credentials via the Admin UI → **Local MCP Servers** → click the ⚙️ icon next to the server, or directly in your `.env` file.

### Server Status

The Admin UI shows each server's current state:
- **Running** (green) — subprocess is active and responding to tool calls
- **Stopped** (gray) — process exited or not started
- **Error** (red) — process crashed; hover for error details

Click **Restart** on any server to restart it after changing credentials.

---

## Testing with Curl

You can fully test Social Brain without any platform credentials by simulating webhook payloads with curl.

> **Important:** For webhook simulation to work, set `INSTAGRAM_ACCESS_TOKEN=test` in your `.env` and restart so the Instagram adapter is registered.

### Simulating an Instagram Comment Webhook

```bash
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "comments",
        "value": {
          "from": { "id": "user_12345", "username": "test_customer" },
          "media": { "id": "media_67890" },
          "id": "comment_001",
          "text": "Interested in pricing!",
          "comment_id": "comment_001"
        }
      }]
    }]
  }'
# Expected: {"received":true}
```

### Simulating a Facebook Page Comment Webhook

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
          "comment_id": "fb_comment_001",
          "post_id": "fb_post_001_PAGE_ID",
          "message": "Love this product! What is the price?",
          "from": { "id": "fb_user_123", "name": "Facebook Customer" },
          "created_time": 1720000000
        }
      }]
    }]
  }'
# Expected: {"received":true}
```

### Simulating a Twitter Mention

```bash
# First, verify the CRC challenge endpoint
curl "http://localhost:3000/api/social/webhooks/twitter?crc_token=test_crc_value"
# Expected: {"response_token":"sha256=..."}

# Then simulate a mention event
curl -X POST http://localhost:3000/api/social/webhooks/twitter \
  -H "Content-Type: application/json" \
  -d '{
    "for_user_id": "YOUR_TWITTER_USER_ID",
    "tweet_create_events": [{
      "id_str": "tweet_test_123",
      "text": "@yourbrand what are your pricing plans?",
      "user": { "id_str": "tw_user_456", "screen_name": "twitter_customer" },
      "created_at": "Mon Jul 01 12:00:00 +0000 2026"
    }]
  }'
```

### Simulating an Instagram DM Webhook

```bash
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "messaging": [{
        "sender": { "id": "user_12345" },
        "recipient": { "id": "page_67890" },
        "timestamp": 1699900000000,
        "message": {
          "mid": "msg_abc123",
          "text": "Hi, I have a question about your product"
        }
      }]
    }]
  }'
# Expected: {"received":true}
```

### CRM and Activity Endpoints

```bash
# Check if contacts were created
curl http://localhost:3000/api/social/contacts | python3 -m json.tool

# View a contact's messages
curl "http://localhost:3000/api/social/contacts/<contact-id>/messages?limit=10" | python3 -m json.tool

# Check activity feed (all recent events)
curl http://localhost:3000/api/social/activity | python3 -m json.tool

# Dashboard stats
curl http://localhost:3000/api/social/stats | python3 -m json.tool

# Platform config status
curl http://localhost:3000/api/social/config | python3 -m json.tool
```

### Automation Rules CRUD

```bash
# Create a rule that matches "interested" and "pricing"
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pricing Interest",
    "platform": "instagram",
    "keywords": "[\"interested\", \"pricing\"]",
    "dm_template": "Hey {{username}}, thanks for your interest! Check out our pricing at https://example.com/pricing",
    "auto_tag": "lead"
  }'

# List all rules
curl http://localhost:3000/api/social/rules | python3 -m json.tool

# Simulate a comment that matches the rule
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "comments",
        "value": {
          "from": { "id": "user_99999", "username": "interested_buyer" },
          "media": { "id": "media_11111" },
          "id": "comment_002",
          "text": "Very interested in your pricing!",
          "comment_id": "comment_002"
        }
      }]
    }]
  }'

# Check the automation log
curl "http://localhost:3000/api/social/rules/log?limit=10" | python3 -m json.tool

# Verify the contact was auto-tagged
curl http://localhost:3000/api/social/contacts | python3 -m json.tool
```

### End-to-End Test Flow

```bash
# 1. Set up environment (add to .env and restart server)
# INSTAGRAM_ACCESS_TOKEN=test
# SOCIAL_WEBHOOK_VERIFY_TOKEN=my-test-token

# 2. Verify the server is running
curl http://localhost:3000/api/social/stats | python3 -m json.tool

# 3. Create an automation rule
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Welcome DM",
    "platform": "instagram",
    "keywords": "[\"hello\", \"hi\", \"hey\"]",
    "dm_template": "Hey {{username}}! Thanks for reaching out. How can we help?",
    "comment_reply_template": "Thanks for commenting! Check your DMs 📬",
    "auto_tag": "engaged"
  }'

# 4. Simulate a comment that triggers the rule
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "comments",
        "value": {
          "from": { "id": "user_test_1", "username": "happy_customer" },
          "media": { "id": "media_test_1" },
          "id": "comment_test_1",
          "text": "Hello! Love this product!",
          "comment_id": "comment_test_1"
        }
      }]
    }]
  }'

# 5. Check the CRM — contact should be created with "engaged" tag
curl http://localhost:3000/api/social/contacts | python3 -m json.tool

# 6. Check the automation log — should show the rule triggered
curl "http://localhost:3000/api/social/rules/log?limit=5" | python3 -m json.tool

# 7. Check activity — should show inbound comment
curl "http://localhost:3000/api/social/activity?limit=5" | python3 -m json.tool

# 8. Simulate a DM (will trigger the Brain Engine if knowledge base is set up)
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "messaging": [{
        "sender": { "id": "user_test_2" },
        "recipient": { "id": "page_test" },
        "timestamp": 1699900000000,
        "message": {
          "mid": "msg_test_1",
          "text": "What are your business hours?"
        }
      }]
    }]
  }'

# 9. Check that the DM was processed
curl http://localhost:3000/api/social/activity | python3 -m json.tool

# 10. Use MCP tools via the chat interface:
# "Look up all contacts tagged engaged"
# "What are the social brain stats?"
# "List my recent Instagram comments"
```

---

## Troubleshooting

### Webhook Issues

| Symptom | Cause | Fix |
|---|---|---|
| Meta webhook verification fails (403) | `SOCIAL_WEBHOOK_VERIFY_TOKEN` doesn't match what you entered in the Meta dashboard | Ensure the `.env` value exactly matches the Meta App Dashboard verify token |
| Webhook returns 200 but no activity shows | Adapter not registered for the platform | Check Settings tab — platform should show "Connected". Ensure access token env var is set and server was restarted |
| "No adapter registered for platform: instagram" in logs | `INSTAGRAM_ACCESS_TOKEN` not set | Set the env var and restart. The adapter is only registered when a token is present |
| Instagram webhooks stop arriving after a while | Meta test mode webhooks expire after 1 hour | Switch to live mode in Meta App Dashboard, or use the "Test" button to resend |
| Twitter CRC challenge returns 500 | `TWITTER_API_SECRET` not set | Set the env var — it's required for HMAC CRC validation |

### Native MCP Server Issues

| Symptom | Cause | Fix |
|---|---|---|
| Server shows "Stopped" in Admin UI | Missing credentials or `uvx`/`npx` not in PATH | Set required env vars, restart the server. Check `PATH` includes uv/node bin dirs |
| DM not sent after rule triggers | Native MCP server for that platform is not running | Check Admin UI → Local MCP Servers — server should show "Running". Restart if stopped |
| "instagram server not running" in logs | `ig-mcp` server crashed or credentials invalid | Check server logs in Admin UI. Verify `INSTAGRAM_ACCESS_TOKEN` is valid and not expired |
| "Tool reply-to-comment not found" | Wrong server started, or server version mismatch | Restart the platform's MCP server from the Admin UI |
| YouTube comment replies failing | YouTube requires OAuth 2.0 (not just an API key) for writes | YouTube Data API write operations need a full OAuth2 credential, not just an API key |

### MCP Sidecars Panel is Missing (Expected)

> **This is correct.** The "MCP Sidecars (Docker)" panel was removed in issue #312. All MCP servers are now native subprocesses shown in the **Local MCP Servers** panel. If you're looking for the Docker sidecar controls, they no longer exist.

### Polling Adapter Issues

| Symptom | Cause | Fix |
|---|---|---|
| YouTube/LinkedIn/Reddit not showing new comments | Polling not started | Check config: `connections.youtube.enabled: true` and `mode: "polling"` |
| Polling stops after server restart | Polling adapters need to be re-registered on boot | Restart is handled automatically if `enabled: true` in config |
| Duplicate comments appearing | `since` timestamp not persisted across restarts | Known limitation for in-memory adapters; the `social_messages` deduplication check prevents duplicate CRM entries |

### Tunnel Issues

| Symptom | Cause | Fix |
|---|---|---|
| `cloudflared: command not found` | cloudflared not installed | Install via `brew install cloudflared` (macOS) or download from [GitHub releases](https://github.com/cloudflare/cloudflared/releases) |
| Quick tunnel URL not working | Tunnel process crashed or not connected | Check terminal output for errors. Restart with `cloudflared tunnel --url http://localhost:3000` |
| Named tunnel shows "No connections" | Credentials file path incorrect or tunnel not running | Verify `~/.cloudflared/config.yml` paths. Run `cloudflared tunnel info <name>` to check status |
| Webhook URL returns 502 | OpenZigs server not running on port 3000 | Start the server first, then the tunnel |

### CRM Issues

| Symptom | Cause | Fix |
|---|---|---|
| Contact not created after webhook | Webhook payload missing required fields (user ID or username) | Check the raw webhook payload in server logs. Ensure `from.id` and `from.username` are present |
| Same person appears as multiple contacts | Different platform_user_id used across sessions (common with Twitter) | Use `social-crm-lookup` to find all contacts, then merge or tag them |

### Brain Engine Issues

| Symptom | Cause | Fix |
|---|---|---|
| AI not auto-replying to DMs | Brain Engine not processing messages | Check server logs for `[SocialBrain]` entries. Ensure the knowledge service is initialized |
| Replies are generic/not helpful | No relevant knowledge base content | Add FAQ documents, product info, etc. to your knowledge directory |
| All messages being escalated | Confidence threshold too high | Set `socialBrain.confidenceThreshold` to `"low"` to reduce escalations |
| Handoff thread not created | Discord/Telegram not configured or bot not in the channel | Ensure `DISCORD_BOT_TOKEN` is set and the bot has access to the configured channel |

### General Issues

| Symptom | Cause | Fix |
|---|---|---|
| Settings tab shows all platforms "Not Configured" | No access tokens set in environment | Set the relevant env vars and restart the server |
| Instagram shows "Token Set — Not Enabled" | Token is present but `connections.instagram.enabled` is not `true` | Add `"socialBrain": {"connections": {"instagram": {"enabled": true}}}` to `~/.openzigs/config.json` |
| Admin Webhooks tab — does it relate to Social Brain? | **No** — the admin Webhooks tab is the general webhook system. Social Brain has its own webhook endpoints | Social Brain webhooks are at `/api/social/webhooks/:platform`. No admin Webhooks tab setup needed |

---

## AI-Assisted Platform Setup (Setup Wizard Agent)

Setting up API credentials for 8 different social platforms can be tedious. OpenZigs includes a **Social Setup Wizard** — a custom agent that uses browser automation and the Secret Vault to walk you through each platform's developer portal, step by step.

### How It Works

The Setup Wizard agent combines three capabilities:
1. **Browser Navigation** (`browser-navigate`) — opens developer portals, clicks through setup flows, takes screenshots so you can see what's happening
2. **Secret Vault** (`get-secret`, `list-secrets`) — securely retrieves your stored credentials (passwords, API keys) without exposing them in chat history
3. **Web Search** (`web-search`) — looks up current documentation if portal layouts have changed

### Prerequisites

Before using the Setup Wizard:

1. **Chrome DevTools must be configured** — see [Chrome DevTools Setup](USER_GUIDE.md#chrome-devtools-setup) in the User Guide
2. **Secret Vault must be unlocked** — go to Admin → Secret Vault, create/unlock your vault
3. **Store your platform credentials in the vault** — add entries for each platform you want to set up:

| Vault Label (recommended) | Service | What to Store |
|---|---|---|
| `Twitter Developer Login` | twitter.com | Your X/Twitter account password |
| `Google Account` | google.com | Google account password (for YouTube) |
| `LinkedIn Login` | linkedin.com | LinkedIn account password |
| `Reddit Login` | reddit.com | Reddit account password |
| `Meta Developer Login` | facebook.com | Facebook account password (for FB + Instagram) |
| `Pinterest Login` | pinterest.com | Pinterest account password |

> **Security Note:** Passwords are stored AES-256-GCM encrypted in `~/.openzigs/vault.enc`. The agent only sees opaque `{{SECRET:uuid}}` reference tokens — plaintext is resolved at the browser level only when typing into form fields. Credentials never appear in chat history, logs, or session files.

### Using the Setup Wizard

Invoke the setup wizard from chat using the **Social Setup Wizard** skill:

```
You: Help me set up my Twitter developer account
Agent: I'll walk you through the Twitter/X developer portal setup. Let me check your vault
       for credentials and open the developer portal...
       [navigates to developer.x.com, takes screenshots, guides you through each step]

You: Set up LinkedIn API access for my app  
Agent: I'll help you create a LinkedIn developer app. First, let me open the LinkedIn
       developer portal...
       [opens linkedin.com/developers, walks through app creation and OAuth setup]

You: I need to set up all my social media APIs
Agent: I'll guide you through each platform one at a time. Let me check which platforms
       you have credentials for in the vault...
       [iterates through platforms with stored credentials]
```

### What the Wizard Can Do

| Platform | Setup Steps Assisted |
|---|---|
| **Twitter/X** | Navigate to developer portal → Create project/app → Copy bearer token → Save to `.env` |
| **YouTube** | Open Google Cloud Console → Enable API → Create credentials → Set up OAuth consent → Copy keys |
| **LinkedIn** | Open developer portal → Create app → Request products → Set redirect URIs → Complete OAuth |
| **Reddit** | Navigate to app preferences → Create script app → Copy client ID/secret |
| **Facebook** | Open Meta Developer dashboard → Create app → Add Instagram Graph API → Generate tokens |
| **Instagram** | Guide through Facebook Business Manager → Link IG account → Configure permissions |
| **Pinterest** | Open developer portal → Create app → Generate access token |
| **TikTok** | Navigate to TikTok for Developers → Create app → Copy API key |

### Important Notes

- The wizard **guides you through** the process but some steps require **your manual input** (e.g., clicking "I Accept" on terms of service, entering 2FA codes)
- The agent takes **screenshots** at each step so you can verify what's happening
- If a platform's portal layout changes, the wizard uses **web search** to find updated instructions
- For **LinkedIn Community Management API** — the wizard can help you create the separate app and submit the access request, but LinkedIn's review process is manual and takes several business days

---

## REST API Reference

### Stats & Config

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/stats` | Dashboard statistics + platform connection status |
| GET | `/api/social/config` | Platform configuration status with setup details |
| GET | `/api/social/connections` | List platform connection status |

### Contacts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/contacts` | List contacts (paginated, filterable by platform/tag) |
| GET | `/api/social/contacts/export` | Export all contacts as CSV |
| GET | `/api/social/contacts/:id` | Get a single contact |
| PATCH | `/api/social/contacts/:id` | Update contact (tags, notes) |
| POST | `/api/social/contacts/:id/tags` | Add a tag |
| DELETE | `/api/social/contacts/:id/tags/:tag` | Remove a tag |
| GET | `/api/social/contacts/:id/messages` | Get message history |

### Activity

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/activity` | Recent activity feed (all platforms) |

### Automation Rules

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/rules` | List all rules (optionally filter by platform) |
| POST | `/api/social/rules` | Create a rule |
| POST | `/api/social/rules/generate` | AI-generate a rule from a description (requires Copilot) |
| GET | `/api/social/rules/:id` | Get a single rule |
| PATCH | `/api/social/rules/:id` | Update a rule |
| DELETE | `/api/social/rules/:id` | Delete a rule |
| GET | `/api/social/rules/log` | Automation execution log |

### Follow-Up Steps

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/rules/:id/follow-ups` | List follow-up steps for a rule |
| POST | `/api/social/rules/:id/follow-ups` | Create a follow-up step |
| DELETE | `/api/social/rules/:id/follow-ups/:stepId` | Delete a follow-up step |

### Leads & Analytics

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/leads` | List captured leads (filterable by platform) |
| GET | `/api/social/analytics` | Per-platform analytics (filterable by `since` param) |

### Handoff

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/social/handoff/:contactId/close` | Close an active handoff |

### Voice Learning

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/voice-learning/stats` | Example count and enabled status |
| DELETE | `/api/social/voice-learning/examples` | Clear all stored voice examples |

### Webhooks

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/webhooks/:platform` | Webhook verification (Meta, TikTok, Twitter CRC) |
| POST | `/api/social/webhooks/:platform` | Inbound webhook payload (`instagram`, `facebook`, `twitter`, `tiktok`, `youtube`) |

---

## Custom Polling Adapter Example

For platforms without webhook support (Reddit, YouTube, LinkedIn), implement a custom polling adapter:

```typescript
import { GenericPollAdapter } from "./channels/social/social-ingestion.js";
import type { IncomingComment } from "./channels/social/types.js";

// YouTube comment polling adapter
const youtubeAdapter = new GenericPollAdapter("youtube", async (since) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const videoIds = ["VIDEO_ID_1", "VIDEO_ID_2"]; // Your video IDs
  const comments: IncomingComment[] = [];

  for (const videoId of videoIds) {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&key=${apiKey}&maxResults=20&order=time&publishedAfter=${since}`;
    const res = await fetch(url);
    const data = await res.json();

    for (const item of data.items ?? []) {
      const snippet = item.snippet.topLevelComment.snippet;
      comments.push({
        platform: "youtube",
        postId: videoId,
        commentId: item.id,
        userId: snippet.authorChannelId?.value ?? "",
        username: snippet.authorDisplayName ?? "",
        text: snippet.textDisplay ?? "",
        timestamp: snippet.publishedAt ?? new Date().toISOString(),
      });
    }
  }

  return comments;
});

// Register and start polling
socialIngestion.registerAdapter(youtubeAdapter);
socialIngestion.startPolling("youtube", 120); // every 2 minutes
```

---

*For additional help, see the main [User Guide](USER_GUIDE.md) or open an issue on GitHub.*
