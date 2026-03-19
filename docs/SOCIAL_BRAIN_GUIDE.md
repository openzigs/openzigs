# Social Brain — Comprehensive Setup & Platform Guide

This guide walks through every step needed to get Social Brain running: Cloudflare Tunnel exposure, platform-by-platform webhook/API configuration, CRM usage, automation rules, AI auto-replies, local testing with curl, and troubleshooting.

> **Prerequisite:** OpenZigs is installed and running. See the main [User Guide](USER_GUIDE.md) for installation instructions.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup)
  - [Prerequisites](#prerequisites)
  - [Option A: Quick Tunnel (Development)](#option-a-quick-tunnel-development)
  - [Option B: Named Tunnel (Production)](#option-b-named-tunnel-production)
  - [Option C: Docker Compose Tunnel](#option-c-docker-compose-tunnel)
  - [Verifying the Tunnel](#verifying-the-tunnel)
- [Environment Variables](#environment-variables)
- [Platform Setup Guides](#platform-setup-guides)
  - [Twitter / X](#twitter--x)
  - [YouTube](#youtube)
    - [YouTube OAuth Setup](#youtube-oauth-setup)
    - [YouTube Upload Quota](#youtube-upload-quota)
  - [LinkedIn](#linkedin)
    - [LinkedIn OAuth Setup](#linkedin-oauth-setup)
  - [Reddit](#reddit)
  - [TikTok](#tiktok)
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
- [REST API Reference](#rest-api-reference)

---

## Architecture Overview

```
                                     ┌─────────────────────┐
  Twitter   ─── Account Activity ──►│                     │
  TikTok    ─── webhook POST ───────►│  Cloudflare Tunnel  │
  YouTube   ─── polling ────────────►│   (cloudflared)     │
  LinkedIn  ─── polling ────────────►│                     │
  Reddit    ─── polling ─────────────►└────────┬────────────┘
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

The `DmDispatcher` (`src/channels/social/dm-dispatcher.ts`) provides a platform-agnostic interface over these servers. It maps Social Brain's `sendDm(platform, userId, text)` and `replyToComment(platform, commentId, text)` calls to the correct MCP server tool with platform-specific parameter names.

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

### Twitter / X

> See the [Twitter / X](#twitter--x) section below for setup details.

---

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

Comment replies and video uploads require an OAuth 2.0 access token (an API key is only sufficient for read operations). To obtain one:

1. In the [Google Cloud Console](https://console.cloud.google.com/), go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID** (application type: **Desktop app** or **Web application**).
3. Under **OAuth consent screen**, add the following scopes:
   - `https://www.googleapis.com/auth/youtube` — full channel access (comments, uploads, metadata)
   - `https://www.googleapis.com/auth/youtube.upload` — upload-only (narrower scope)
4. Use the [Google OAuth Playground](https://developers.google.com/oauthplayground/) or your own OAuth flow to exchange the client credentials for an access token.
5. Set the token in your `.env`:
   ```
   YOUTUBE_OAUTH_TOKEN=ya29.a0AfH6SM...
   ```

> **Token refresh:** OAuth2 access tokens expire (typically 1 hour). For production use, implement a refresh token flow or use a service like [google-auth-library](https://github.com/googleapis/google-auth-library-python) to auto-refresh. The `youtube-mcp` server currently expects a valid bearer token in `YOUTUBE_OAUTH_TOKEN`.

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

#### Step-by-Step Setup

**1. Create a Developer App:**

1. Go to [developer.x.com/en/portal/dashboard](https://developer.x.com/en/portal/dashboard)
2. Create a new project and app
3. Select at least **Basic** tier (free tier has very limited access)
4. Save your **Bearer Token**, **API Key**, and **API Secret**

**2. Set environment variables:**

```dotenv
TWITTER_BEARER_TOKEN=your-bearer-token
TWITTER_API_KEY=your-api-key
TWITTER_API_SECRET=your-api-key-secret
```

**3. Configure webhook (Account Activity API — Pro tier):**

The Account Activity API (Pro tier, $5,000/month) provides real-time webhooks for mentions, DMs, and other user activity:

```bash
# Register a webhook URL
curl -X POST "https://api.x.com/2/webhooks" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-tunnel-url>/api/social/webhooks/twitter"}'

# The endpoint will respond to the CRC challenge automatically
```

**4. Alternative — Polling with X API v2 (Free/Basic tier):**

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

> **Rate limits:** X API v2 free tier allows 500 tweet reads/month. Basic tier ($100/month) allows 10,000 reads/month. Pro tier ($5,000/month) includes webhook support and higher limits.

---

### TikTok

**1. Create a TikTok Developer App:**

1. Go to [developers.tiktok.com](https://developers.tiktok.com/)
2. Create a developer account and register an app
3. Request the following scopes:
   - `comment.list` — read comments on your videos
   - `comment.list.manage` — reply to comments
   - `direct_message` — send and receive DMs (limited availability)

**2. Configure Webhooks:**

1. In the TikTok Developer Portal, navigate to your app's **Webhooks** section
2. Add a webhook subscription:
   - **Callback URL:** `https://<your-tunnel-url>/api/social/webhooks/tiktok`
   - **Verification Token:** same as `SOCIAL_WEBHOOK_VERIFY_TOKEN`
3. Subscribe to events:
   - `comment.create` — new comments on your videos
   - `direct_message.receive` — incoming DMs (if available)

**3. Set environment variables:**

```dotenv
TIKTOK_ACCESS_TOKEN=your-tiktok-access-token
```

TikTok uses a similar verification challenge to Meta — a `GET` request with `hub.verify_token` and `hub.challenge`.

> **Note:** TikTok's DM API is currently limited to select partners. Comment automation works, but DM sending may require approval from TikTok.

> **Important:** TikTok has **no dedicated MCP server** in OpenZigs. Webhook ingestion works (comments arrive via the `/api/social/webhooks/tiktok` endpoint and are processed by the Comment Rule Engine), but there are **no outbound posting, DM, or comment reply tools** for TikTok. To publish content on TikTok, use the TikTok Creator Tools or a third-party scheduler. The other 6 platforms (Instagram, Facebook, Twitter/X, YouTube, LinkedIn, Reddit) all have full MCP server coverage — see [Posting to Social Media](#posting-to-social-media).

---

### Reddit

Reddit does not support webhooks. Use the polling adapter.

**1. Create a Reddit App:**

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Click **create another app**
3. Select **script** type
4. Set the redirect URI to `http://localhost:3000` (not used for polling)
5. Note the **client ID** (under the app name) and **secret**

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

---

### LinkedIn

LinkedIn uses OAuth 2.0 (3-legged authorization code flow) for API access. OpenZigs includes a built-in OAuth flow that handles token exchange, storage, and auto-refresh.

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
