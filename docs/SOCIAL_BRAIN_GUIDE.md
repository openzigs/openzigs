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
  - [Instagram / Facebook (Meta Graph API)](#instagram--facebook-meta-graph-api)
  - [YouTube](#youtube)
  - [Twitter / X](#twitter--x)
  - [TikTok](#tiktok)
  - [Reddit](#reddit)
  - [LinkedIn](#linkedin)
- [Settings Tab — Connection Status](#settings-tab--connection-status)
- [CRM Usage Guide](#crm-usage-guide)
- [Automation Rules (Comment-to-DM)](#automation-rules-comment-to-dm)
- [AI Auto-Reply (Brain Engine)](#ai-auto-reply-brain-engine)
- [Human Handoff](#human-handoff)
- [MCP Tools (Chat Interface)](#mcp-tools-chat-interface)
- [Testing with Curl](#testing-with-curl)
  - [Simulating an Instagram Comment Webhook](#simulating-an-instagram-comment-webhook)
  - [Simulating an Instagram DM Webhook](#simulating-an-instagram-dm-webhook)
  - [CRM and Activity Endpoints](#crm-and-activity-endpoints)
  - [Automation Rules CRUD](#automation-rules-crud)
  - [End-to-End Test Flow](#end-to-end-test-flow)
- [Troubleshooting](#troubleshooting)
- [REST API Reference](#rest-api-reference)

---

## Architecture Overview

```
                                     ┌─────────────────────┐
  Instagram ─── webhook POST ───────►│                     │
  YouTube   ─── PubSubHubbub ──────►│  Cloudflare Tunnel  │
  Twitter   ─── Account Activity ──►│   (cloudflared)     │
  TikTok    ─── webhook POST ──────►│                     │
                                     └────────┬────────────┘
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
                 │              │  │   DM/reply)  │  │                  │
                 └──────┬───────┘  └──────────────┘  └────────┬─────────┘
                        │                                      │
                        ▼                                      ▼
                 ┌──────────────┐                    ┌──────────────────┐
                 │  CRM (SQLite)│                    │  Handoff Manager │
                 │  contacts,   │                    │  (Discord/       │
                 │  messages,   │                    │   Telegram)      │
                 │  rules, log  │                    └──────────────────┘
                 └──────────────┘
```

**Data flow:**

1. Platform sends webhook to your public URL → Cloudflare Tunnel → OpenZigs
2. Platform adapter parses the payload into a normalised message/comment
3. Comments are enriched with post context (caption, permalink) via the platform API
4. Comment Rule Engine evaluates keyword/regex rules for comment-to-DM automation
5. DMs are processed by the Brain Engine (RAG + LLM) for AI auto-replies
6. Low-confidence replies are escalated to a human via Discord/Telegram handoff
7. Everything is logged in the CRM (contacts, messages, automation log)

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

# Or on macOS with launchd
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
SOCIAL_WEBHOOK_VERIFY_TOKEN=your-random-secret-string   # Used by Meta/TikTok to verify webhook subscriptions

# ── Platform Access Tokens (set only the platforms you use) ──
INSTAGRAM_ACCESS_TOKEN=your-instagram-user-access-token  # Meta Graph API token for Instagram
# FACEBOOK_ACCESS_TOKEN=your-facebook-page-access-token  # For Facebook Pages
# TWITTER_ACCESS_TOKEN=your-twitter-bearer-token         # X/Twitter API v2
# TIKTOK_ACCESS_TOKEN=your-tiktok-access-token           # TikTok for Developers
# YOUTUBE_ACCESS_TOKEN=your-youtube-api-key              # YouTube Data API v3
# REDDIT_ACCESS_TOKEN=your-reddit-token                  # Reddit API (OAuth)
# LINKEDIN_ACCESS_TOKEN=your-linkedin-token              # LinkedIn Marketing API
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
      "instagram": {
        "enabled": true,
        "mode": "webhook",
        "accessToken": "your-token-here"
      },
      "youtube": {
        "enabled": true,
        "mode": "polling",
        "pollIntervalSeconds": 120
      }
    }
  }
}
```

> **Note:** Environment variables take precedence over config file values. If both `INSTAGRAM_ACCESS_TOKEN` and `socialBrain.connections.instagram.accessToken` are set, the env var wins.

---

## Platform Setup Guides

### Instagram / Facebook (Meta Graph API)

Instagram webhooks are delivered via the Meta Graph API. You need a **Meta Developer App** with the **Instagram** product added.

#### Prerequisites

- A **Facebook Page** linked to your Instagram Professional account (Business or Creator)
- A **Meta Developer App** (type: Business)

#### Step-by-Step Setup

**1. Create a Meta Developer App**

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps/)
2. Click **Create App** → select **Business** type → click **Next**
3. Enter an app name (e.g., "OpenZigs Social Brain") and select your business portfolio
4. Click **Create App**

**2. Add Instagram Product**

1. In the app dashboard, click **Add Product** in the left sidebar
2. Find **Instagram** and click **Set Up**
3. This adds Instagram API access to your app

**3. Generate Access Token**

1. Navigate to **Instagram → API Setup with Instagram Login** (or **Basic Display**)
2. Add your Instagram Professional account as a test user
3. Generate a **User Access Token** with these permissions:
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `pages_show_list`
   - `pages_read_engagement`
4. Copy the token and set it as `INSTAGRAM_ACCESS_TOKEN` in your `.env`

> **Token expiry:** Instagram User Access Tokens expire after 60 days. For production, implement token refresh using the [long-lived token exchange](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#exchange-a-short-lived-token-for-a-long-lived-token). Short-lived tokens last 1 hour.

**4. Configure Webhooks**

1. In the app dashboard, navigate to **Instagram → Webhooks** (left sidebar)
2. Click **Configure** (or **Subscribe to events**)
3. Enter:
   - **Callback URL:** `https://<your-tunnel-url>/api/social/webhooks/instagram`
   - **Verify Token:** the same value as `SOCIAL_WEBHOOK_VERIFY_TOKEN` in your `.env`
4. Click **Verify and Save**
   - Meta sends a `GET` request with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`
   - OpenZigs validates the token and responds with the `hub.challenge` value
   - If verification fails, check that your tunnel is running and the verify token matches
5. Subscribe to these webhook fields:
   - `comments` — triggers when someone comments on your posts
   - `messages` — triggers when someone sends a DM
   - `messaging_postbacks` — (optional) for quick reply buttons
   - `messaging_referral` — (optional) for ad click-to-message

**5. Test It**

```bash
# Use the Meta App Dashboard's built-in test tool:
# Go to Instagram → Webhooks → click "Test" next to the "comments" field

# Or send a real comment on one of your Instagram posts and watch the Activity tab

# Check if the webhook was received:
curl http://localhost:3000/api/social/activity | python3 -m json.tool
```

#### Instagram Webhook Payload Reference

**Comment webhook:**

```json
{
  "entry": [{
    "changes": [{
      "field": "comments",
      "value": {
        "from": { "id": "12345", "username": "commenter" },
        "media": { "id": "media_789" },
        "comment_id": "comment_001",
        "text": "Interested in pricing!"
      }
    }]
  }]
}
```

**DM webhook:**

```json
{
  "entry": [{
    "messaging": [{
      "sender": { "id": "12345" },
      "recipient": { "id": "67890" },
      "timestamp": 1699900000000,
      "message": {
        "mid": "msg_abc123",
        "text": "Hello, I have a question"
      }
    }]
  }]
}
```

#### Post Context Enrichment

When a comment arrives, OpenZigs automatically calls the Instagram Graph API to fetch the post's metadata:

```
GET /{media_id}?fields=caption,permalink,media_type,media_url,username,timestamp
Authorization: Bearer {INSTAGRAM_ACCESS_TOKEN}
```

This data is cached in SQLite for 24 hours and made available as:
- `{{post_caption}}` — in DM templates
- `{{post_url}}` — in DM templates
- Post context block in the Brain Engine's LLM prompt

Without the access token, comment-to-DM automation still works, but templates won't have post context.

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

The callback receives Atom XML payloads when new videos are published. OpenZigs would need a YouTube-specific adapter to parse these.

#### Approach B: Polling with YouTube Data API v3 (Comments)

For comment monitoring, use the polling adapter pattern with the YouTube Data API:

**1. Get a YouTube Data API key:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for **YouTube Data API v3** and click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → API Key**
7. Copy the key and set it as `YOUTUBE_ACCESS_TOKEN` in your `.env`

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

# List comment replies
curl "https://www.googleapis.com/youtube/v3/comments?part=snippet&parentId=COMMENT_ID&key=YOUR_API_KEY"
```

> **Quota:** YouTube Data API has a daily quota of 10,000 units. `commentThreads.list` costs 1 unit per call. With 120-second polling, that's ~720 calls/day — well within the free quota.

**4. Responding to comments:**

YouTube does not support DMs. The automation can:
- Reply to comments via the API (`POST commentThreads.insert`)
- Auto-tag contacts in the CRM for follow-up

> **Note:** YouTube comment polling requires a custom `GenericPollAdapter` implementation. See the [code example](#custom-polling-adapter-example) below.

---

### Twitter / X

Twitter/X webhook support depends on your API access tier.

#### Step-by-Step Setup

**1. Create a Developer App:**

1. Go to [developer.x.com/en/portal/dashboard](https://developer.x.com/en/portal/dashboard)
2. Create a new project and app
3. Select at least **Basic** tier (free tier has limited access)
4. Save your **Bearer Token** and **API Key/Secret**

**2. Set environment variables:**

```dotenv
TWITTER_ACCESS_TOKEN=your-bearer-token
```

**3. Configure webhook (if using Account Activity API):**

The Account Activity API (Pro tier) provides real-time webhooks for mentions, DMs, and other user activity:

```bash
# Register a webhook URL
curl -X POST "https://api.x.com/2/webhooks" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-tunnel-url>/api/social/webhooks/twitter"}'

# Subscribe to user events
curl -X POST "https://api.x.com/2/subscriptions" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN"
```

**4. Alternative — Polling with X API v2:**

For free/basic tier without webhook support, use polling:

```bash
# Search for mentions
curl "https://api.x.com/2/tweets/search/recent?query=@yourusername&tweet.fields=created_at,author_id" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN"

# Get DMs (requires OAuth 2.0 user context)
curl "https://api.x.com/2/dm_events" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

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

> **Rate limits:** X API v2 free tier allows 500 tweets/month reading. Basic tier ($100/month) allows 10,000 reads/month. Pro tier ($5,000/month) includes webhook support.

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

---

### Reddit

Reddit does not support webhooks. Use the polling adapter.

**1. Create a Reddit App:**

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Click **create another app**
3. Select **script** type
4. Set the redirect URI to `http://localhost:3000` (not used for polling)
5. Note the **client ID** (under the app name) and **secret**

**2. Get an access token:**

```bash
curl -X POST https://www.reddit.com/api/v1/access_token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=password&username=YOUR_USERNAME&password=YOUR_PASSWORD"
```

**3. Set environment variables:**

```dotenv
REDDIT_ACCESS_TOKEN=your-reddit-bearer-token
```

**4. Enable polling:**

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

**5. Reddit API endpoints used:**

```bash
# Get new comments on a subreddit
curl "https://oauth.reddit.com/r/YOUR_SUBREDDIT/comments?limit=25&sort=new" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "User-Agent: openzigs/1.0"

# Get inbox messages (DMs)
curl "https://oauth.reddit.com/message/inbox?limit=25" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "User-Agent: openzigs/1.0"
```

> **Rate limit:** Reddit allows 60 requests per minute per OAuth token.

---

### LinkedIn

LinkedIn's API does not support traditional webhooks for comments or messages. Use the LinkedIn MCP sidecar for posting, and set up polling for monitoring.

**1. Create a LinkedIn App:**

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps/)
2. Create a new app and request access to:
   - **Sign In with LinkedIn using OpenID Connect**
   - **Share on LinkedIn** (for posting)
   - **Marketing Developer Platform** (for organization pages)
3. Generate an access token via 3-legged OAuth

**2. Set environment variables:**

```dotenv
LINKEDIN_ACCESS_TOKEN=your-linkedin-access-token
```

**3. LinkedIn API endpoints:**

```bash
# Get organization posts
curl "https://api.linkedin.com/v2/organizationShares?q=owners&owners=urn:li:organization:YOUR_ORG_ID&count=10" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Get comments on a post
curl "https://api.linkedin.com/v2/socialActions/urn:li:share:POST_ID/comments?start=0&count=20" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

> **Note:** LinkedIn heavily rate-limits API access and requires app review for production use. The MCP sidecar (`linkedin-mcp-server`) handles most LinkedIn interactions; Social Brain CRM integration polls for new comments/messages.

---

## Settings Tab — Connection Status

Navigate to `/social` and click the **Settings** tab to see platform connection status at a glance:

| Status | Meaning |
|---|---|
| **Connected** (green) | Access token is configured and adapter is registered |
| **Token Set — Not Enabled** (yellow) | Token is present but platform is not enabled in config |
| **Not Configured** (gray) | No access token found |

Each platform card shows:
- The required environment variable name
- The webhook endpoint path
- A link to the platform's developer documentation

---

## CRM Usage Guide

### Contacts

Every user who sends a DM or comment is automatically added to the CRM. Contact records include:

| Field | Description |
|---|---|
| `username` | Platform username |
| `display_name` | Full name (if available) |
| `platform` | Source platform |
| `tags` | JSON array of tags for segmentation |
| `notes` | Free-text CRM notes |
| `message_count` | Total messages exchanged |
| `handoff_active` | Whether a human handoff is in progress |

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
| **Platform** | Target platform (`instagram`, `youtube`, etc.) |
| **Keywords** | Comma-separated trigger words (case-insensitive, word-boundary match) |
| **DM Template** | Message to send, with variable interpolation |
| **Comment Reply** | (Optional) Public reply to the comment |
| **DM Delay** | Seconds to wait before sending the DM |
| **Max per User** | Maximum times a single user can trigger this rule |
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

**Free Resource:**
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

## AI Auto-Reply (Brain Engine)

The Brain Engine processes incoming DMs through a RAG pipeline:

1. **Knowledge search** — Searches your local knowledge base for relevant documents
2. **Conversation history** — Loads the last 5 messages for context
3. **Post context** — If the message relates to a comment, includes the post's caption and URL
4. **LLM call** — Sends everything to the model with a social-media-specific system prompt
5. **Confidence routing:**
   - **High confidence** → auto-sends the reply
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

1. Brain Engine returns `shouldEscalate: true`
2. Handoff Manager creates a thread in the configured Discord/Telegram channel
3. Contact's CRM record is updated: `handoff_active: 1`
4. The contact detail drawer shows an orange "Handoff Active" banner
5. Admin replies in the thread are forwarded back to the user
6. Close the handoff from the CRM or via the `social-close-handoff` MCP tool

### Close via API

```bash
curl -X POST http://localhost:3000/api/social/handoff/<contactId>/close \
  -H "Content-Type: application/json" \
  -d '{"resolution": "Issue resolved — refund processed"}'
```

---

## MCP Tools (Chat Interface)

5 Social Brain tools are available in the chat interface:

| Tool | Risk | Description |
|---|---|---|
| `social-crm-lookup` | 🟢 low | Search CRM contacts by username, platform, tag, or free text |
| `social-crm-history` | 🟢 low | Get message history for a contact |
| `social-crm-tag` | 🟢 low | Add a tag to a contact |
| `social-close-handoff` | 🟡 medium | Close an active human handoff |
| `social-brain-stats` | 🟢 low | Get dashboard statistics |

**Example chat prompts:**

```
Look up all Instagram contacts tagged "lead"

Show me the message history for contact abc123

Tag contact abc123 as "high-value"

Close the handoff for contact abc123 with resolution "issue resolved"

What are the current Social Brain stats?
```

---

## Testing with Curl

You can fully test Social Brain without any platform credentials by simulating webhook payloads with curl.

> **Important:** For webhook simulation to work, you need `INSTAGRAM_ACCESS_TOKEN` set (even a dummy value) so the Instagram adapter is registered. Set `INSTAGRAM_ACCESS_TOKEN=test` in your `.env` and restart.

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
          "comment_id": "comment_001",
          "text": "Interested in pricing!",
          "id": "comment_001"
        }
      }]
    }]
  }'
# Expected: {"received":true}
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
# Check if the contact was created
curl http://localhost:3000/api/social/contacts | python3 -m json.tool

# View the contact's messages
curl "http://localhost:3000/api/social/contacts/<contact-id>/messages?limit=10" | python3 -m json.tool

# Check activity feed
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

# Now simulate a comment that matches the rule
curl -X POST http://localhost:3000/api/social/webhooks/instagram \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "comments",
        "value": {
          "from": { "id": "user_99999", "username": "interested_buyer" },
          "media": { "id": "media_11111" },
          "comment_id": "comment_002",
          "text": "Very interested in your pricing!",
          "id": "comment_002"
        }
      }]
    }]
  }'

# Check the automation log
curl "http://localhost:3000/api/social/rules/log?limit=10" | python3 -m json.tool

# Check that the contact was auto-tagged
curl http://localhost:3000/api/social/contacts | python3 -m json.tool
```

### End-to-End Test Flow

Here's a complete test scenario:

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
          "comment_id": "comment_test_1",
          "text": "Hello! Love this product!",
          "id": "comment_test_1"
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
| Payload received but comment not parsed | Unexpected payload format from the platform | Check server logs for `[SocialIngestion] Webhook parse error`. The adapter may need updating for a new API version |

### Tunnel Issues

| Symptom | Cause | Fix |
|---|---|---|
| `cloudflared: command not found` | cloudflared not installed | Install via `brew install cloudflared` (macOS) or download from [GitHub releases](https://github.com/cloudflare/cloudflared/releases) |
| Quick tunnel URL not working | Tunnel process crashed or not connected | Check terminal output for errors. Restart with `cloudflared tunnel --url http://localhost:3000` |
| Named tunnel shows "No connections" | Credentials file path incorrect or tunnel not running | Verify `~/.cloudflared/config.yml` paths. Run `cloudflared tunnel info <name>` to check status |
| Webhook URL returns 502 | OpenZigs server not running on port 3000 | Start the server first, then the tunnel |
| WebSocket connections fail through tunnel | Cloudflare free plan limitations | Ensure `websocket` is not blocked. Named tunnels handle WebSockets natively |

### CRM Issues

| Symptom | Cause | Fix |
|---|---|---|
| Contact not created after webhook | Webhook payload missing required fields (user ID or username) | Check the raw webhook payload in server logs. Ensure `from.id` and `from.username` are present |
| Tags not appearing on contacts | Tag was added to wrong contact ID | Use `social-crm-lookup` to find the correct contact ID first |
| Message history empty for a contact | Messages stored under a different contact ID | Check if duplicate contacts exist for the same user (e.g., different platform user IDs) |
| CSV export is empty | No contacts in the database | Send some test webhooks first |

### Automation Issues

| Symptom | Cause | Fix |
|---|---|---|
| Rule not triggering | Keywords don't match (word-boundary, case-insensitive) | Check that the keyword appears as a whole word in the comment. "interested" won't match "uninterested" |
| DM not sent after rule triggers | DM sending requires actual platform API access (not just a test token) | With `INSTAGRAM_ACCESS_TOKEN=test`, the DM will fail but the rule still triggers and logs. The `dm_error` field in the automation log shows the failure |
| `{{post_caption}}` is empty in DM | Access token invalid or post context fetch failed | Check server logs for `Post context enrichment failed`. Ensure `INSTAGRAM_ACCESS_TOKEN` is a valid token |
| Max triggers exceeded | `max_triggers_per_user` limit reached for this user | Increase the limit or create a new rule |

### Brain Engine Issues

| Symptom | Cause | Fix |
|---|---|---|
| AI not auto-replying to DMs | Brain Engine not processing messages | Check server logs for `[SocialBrain]` entries. Ensure the knowledge service is initialized |
| Replies are generic/not helpful | No relevant knowledge base content | Add FAQ documents, product info, etc. to your knowledge directory |
| All messages are being escalated | Confidence threshold too high | Set `socialBrain.confidenceThreshold` to `"low"` to reduce escalations |
| Handoff thread not created | Discord/Telegram not configured or bot not in the channel | Ensure `DISCORD_BOT_TOKEN` is set and the bot has access to the configured channel |

### General Issues

| Symptom | Cause | Fix |
|---|---|---|
| Settings tab shows all platforms "Not Configured" | No access tokens set in environment | Set the relevant env vars and restart the server |
| Instagram shows "Token Set — Not Enabled" | Token is present but `connections.instagram.enabled` is not `true` | Add `"socialBrain": {"connections": {"instagram": {"enabled": true}}}` to `~/.openzigs/config.json` |
| Admin Webhooks tab → does it relate to Social Brain? | **No** — the admin Webhooks tab is the general webhook system. Social Brain has its own webhook endpoints | Social Brain webhooks are at `/api/social/webhooks/:platform`. No admin Webhooks tab setup needed |

---

## REST API Reference

### Stats & Config

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/stats` | Dashboard statistics + connection status |
| GET | `/api/social/config` | Platform configuration status with setup details |
| GET | `/api/social/connections` | List platform connection status |

### Contacts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/contacts` | List contacts (paginated, filterable) |
| GET | `/api/social/contacts/export` | Export all contacts as CSV |
| GET | `/api/social/contacts/:id` | Get a single contact |
| PATCH | `/api/social/contacts/:id` | Update contact (tags, notes) |
| POST | `/api/social/contacts/:id/tags` | Add a tag |
| DELETE | `/api/social/contacts/:id/tags/:tag` | Remove a tag |
| GET | `/api/social/contacts/:id/messages` | Get message history |

### Activity

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/activity` | Recent activity feed |

### Automation Rules

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/rules` | List all rules (optionally filter by platform) |
| POST | `/api/social/rules` | Create a rule |
| GET | `/api/social/rules/:id` | Get a single rule |
| PATCH | `/api/social/rules/:id` | Update a rule |
| DELETE | `/api/social/rules/:id` | Delete a rule |
| GET | `/api/social/rules/log` | Automation execution log |

### Handoff

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/social/handoff/:contactId/close` | Close an active handoff |

### Webhooks

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/social/webhooks/:platform` | Webhook verification (Meta, TikTok) |
| POST | `/api/social/webhooks/:platform` | Inbound webhook payload |

---

## Custom Polling Adapter Example

For platforms without webhook support (Reddit, YouTube), implement a custom polling adapter:

```typescript
import { GenericPollAdapter } from "./channels/social/social-ingestion.js";
import type { IncomingComment } from "./channels/social/types.js";

// YouTube comment polling adapter
const youtubeAdapter = new GenericPollAdapter("youtube", async (since) => {
  const apiKey = process.env.YOUTUBE_ACCESS_TOKEN;
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
