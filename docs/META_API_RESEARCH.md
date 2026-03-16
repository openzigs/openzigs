# Meta API Access Research: Instagram & Facebook

**Date:** March 15, 2026  
**Status:** Research Complete — Ready for Implementation

---

## Executive Summary

Both Instagram and Facebook APIs are accessible through Meta's unified **Graph API** platform. You already have production-quality MCP servers for both platforms cloned in `external/ig-mcp/` and `external/fb-mcp/`. The servers are **not currently wired** into the tool system (not in `config/tools.json` or `nativeMcpServers`). Re-enabling them requires:

1. **A Meta Developer App** (one app covers both Instagram + Facebook)
2. **An Instagram Professional account** linked to a Facebook Page
3. **OAuth access tokens** (short-lived → long-lived, 60-day expiry with refresh)
4. **Wiring the MCP servers** into `config/default.json` under `nativeMcpServers`

**Difficulty: Medium** — The API is well-documented and the MCP servers exist. The main friction is Meta's App Review process for Advanced Access if you need to serve accounts you don't own.

---

## 1. Authentication Methodology

### OAuth 2.0 Flow (Both Instagram + Facebook)

Meta uses standard **OAuth 2.0** with two login variants:

| Login Type | Best For | Token Scope |
|---|---|---|
| **Business Login for Instagram** | Apps where users log in with Instagram credentials | Instagram User access tokens via `graph.instagram.com` |
| **Facebook Login for Business** | Apps where IG accounts are linked to Facebook Pages | Facebook User access tokens via `graph.facebook.com` |

### Token Lifecycle

```
Authorization Code (1-hour validity)
    → Exchange for Short-Lived Access Token (1 hour)
        → Exchange for Long-Lived Access Token (60 days)
            → Refresh before expiry (new 60-day token)
```

**For personal use (Standard Access),** you can skip OAuth flows entirely and generate tokens directly from the **Graph API Explorer** at `developers.facebook.com/tools/explorer`.

### Key API Endpoints

```bash
# Exchange auth code for short-lived token
GET https://graph.facebook.com/v25.0/oauth/access_token?
  client_id={APP_ID}&redirect_uri={REDIRECT_URI}&client_secret={APP_SECRET}&code={CODE}

# Exchange short-lived for long-lived token (60 days)
GET https://graph.facebook.com/v25.0/oauth/access_token?
  grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={SHORT_TOKEN}

# Get pages and IG business account
GET /me/accounts  → returns Page ID + Page Access Token
GET /{page-id}?fields=instagram_business_account  → returns IG Business Account ID
```

---

## 2. Instagram API Access

### Requirements
- **Instagram Professional Account** (Business or Creator) — free to set up in Instagram app settings
- **Connected to a Facebook Page** — required for API publishing
- **Facebook Developer Account** — free at developers.facebook.com
- **Meta App (Business type)** — free to create in App Dashboard

### Required Permissions (Standard Access = immediate, no review needed)
| Permission | Purpose |
|---|---|
| `instagram_basic` / `instagram_business_basic` | Read profile, media |
| `instagram_content_publish` / `instagram_business_content_publish` | Publish images, videos, reels, stories, carousels |
| `instagram_manage_comments` / `instagram_business_manage_comments` | Read/reply/delete comments |
| `instagram_manage_insights` / `instagram_business_manage_insights` | Analytics and metrics |
| `pages_show_list` | List connected Facebook Pages |
| `pages_read_engagement` | Read Page engagement data |

### Advanced Access (requires Meta App Review + Business Verification)
| Permission | Purpose |
|---|---|
| `instagram_manage_messages` / `instagram_business_manage_messages` | DMs — read/send direct messages |

### Content Publishing API
- **Supported media types:** Images (JPEG only), Videos, Reels, Stories, Carousels (up to 10 items)
- **Rate limit:** 100 API-published posts per 24-hour rolling window (carousels count as 1)
- **Media hosting:** Images/videos must be on a **publicly accessible URL** (Meta cURLs them)
- **Resumable uploads:** Available for large videos via `rupload.facebook.com`
- **Workflow:** Create container → Upload media → Publish container

```bash
# 1. Create media container
POST /{IG_ID}/media
  image_url=https://example.com/photo.jpg&caption=Hello+World

# 2. Publish container
POST /{IG_ID}/media_publish
  creation_id={CONTAINER_ID}
```

### API Rate Limits
- General endpoints: `4800 × Number of Impressions` calls per 24h per app-user pair
- Publishing: 100 posts per 24h

---

## 3. Facebook Pages API Access

### Requirements
- Same Meta App as Instagram (one app covers both)
- Facebook Page owned or managed by the user
- Page Access Token (obtained via `/me/accounts`)

### Required Permissions
| Permission | Purpose |
|---|---|
| `pages_show_list` | List managed Pages |
| `pages_read_engagement` | Read Page engagement |
| `pages_manage_posts` | Create, update, delete posts |
| `pages_manage_metadata` | Manage Page settings |
| `pages_read_user_content` | Read user-posted content |

### Facebook Pages API Capabilities (via the fb-mcp server)
- **Post publishing:** Text posts, image posts, link shares, scheduled posts
- **Comment moderation:** Read, reply, delete, hide/unhide comments
- **Insights/Analytics:** Post impressions, engagement, reach, clicks, reactions
- **Messenger:** Read conversations, send messages (within 24h window)
- **Page management:** Fan counts, share counts, reaction breakdowns

---

## 4. Existing MCP Servers

### Already In Your Repo

| Server | Location | Language | Stars | Tools | Status |
|---|---|---|---|---|---|
| **ig-mcp** (jlbadano) | `external/ig-mcp/` | Python | 88 | 8+ (profile, media, insights, publish, DM, pages) | Cloned, not wired |
| **fb-mcp** (custom) | `external/fb-mcp/` | Python | — | 10 (posts, insights, comments, messenger, page info) | Cloned, not wired |

### Other Notable MCP Servers on GitHub

| Repo | Stars | Focus | Language |
|---|---|---|---|
| `pipeboard-co/meta-ads-mcp` | 631 | Meta Ads management (FB + IG ads) | Python |
| `gomarble-ai/facebook-ads-mcp-server` | 254 | Facebook Ads | Python |
| `HagaiHen/facebook-mcp-server` | 120 | FB Pages: posts, comments, insights, moderation | Python |
| `duhlink/instagram-server-next-mcp` | 47 | Instagram + TypeScript | TypeScript |

**Recommendation:** Use your existing `ig-mcp` and `fb-mcp` servers. They're already structured for your codebase pattern (Python stdio MCP servers in `external/`). The ig-mcp server is well-maintained (MCP SDK v1.0+ compatible, DM support added recently).

---

## 5. Environment Variables Required

### Instagram (`ig-mcp`)
```env
INSTAGRAM_ACCESS_TOKEN=<long-lived-access-token>
FACEBOOK_APP_ID=<your-app-id>
FACEBOOK_APP_SECRET=<your-app-secret>
INSTAGRAM_BUSINESS_ACCOUNT_ID=<your-ig-business-id>
INSTAGRAM_API_VERSION=v25.0
```

### Facebook (`fb-mcp`)
```env
FACEBOOK_PAGE_TOKEN=<page-access-token>
FACEBOOK_APP_ID=<your-app-id>
FACEBOOK_APP_SECRET=<your-app-secret>
FACEBOOK_PAGE_ID=<your-page-id>   # auto-detected if omitted
META_GRAPH_API_VERSION=v25.0
```

---

## 6. Setup Steps to Re-Enable

### Step 1: Create Meta App (if you don't have one)
1. Go to `developers.facebook.com` → Log in
2. **Create App** → Select "Other" use case → Select "Business" app type
3. Name it (e.g., "OpenZigs Social") → Connect a business portfolio
4. **Add Products:** Instagram (API setup with Instagram login) + Facebook Login for Business
5. Note your **App ID** and **App Secret** from Settings → Basic

### Step 2: Get Access Tokens
**Quick method (for personal/testing use):**
1. Go to `developers.facebook.com/tools/explorer`
2. Select your app → Generate User Access Token
3. Grant required permissions → Copy token
4. Exchange for long-lived token:
   ```bash
   curl "https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={SHORT_TOKEN}"
   ```
5. Get Page token: `GET /me/accounts` → extract `access_token` for your Page
6. Get IG Business ID: `GET /{page-id}?fields=instagram_business_account`

### Step 3: Wire MCP Servers into OpenZigs
Add to `~/.openzigs/config.json` (user config) under `copilot.nativeMcpServers`:

```json
{
  "copilot": {
    "nativeMcpServers": {
      "instagram": {
        "command": "python3",
        "args": ["external/ig-mcp/src/instagram_mcp_server.py"],
        "env": {
          "INSTAGRAM_ACCESS_TOKEN": "{{secret:INSTAGRAM_ACCESS_TOKEN}}",
          "FACEBOOK_APP_ID": "{{secret:FACEBOOK_APP_ID}}",
          "FACEBOOK_APP_SECRET": "{{secret:FACEBOOK_APP_SECRET}}",
          "INSTAGRAM_BUSINESS_ACCOUNT_ID": "{{secret:INSTAGRAM_BUSINESS_ACCOUNT_ID}}"
        }
      },
      "facebook": {
        "command": "python3",
        "args": ["external/fb-mcp/src/facebook_mcp_server.py"],
        "env": {
          "FACEBOOK_PAGE_TOKEN": "{{secret:FACEBOOK_PAGE_TOKEN}}",
          "FACEBOOK_APP_ID": "{{secret:FACEBOOK_APP_ID}}",
          "FACEBOOK_APP_SECRET": "{{secret:FACEBOOK_APP_SECRET}}"
        }
      }
    }
  }
}
```

### Step 4: Add Tools to `config/tools.json`
Add the tool names from each MCP server to the `enabledTools` array:

**Instagram tools:**
- `get_profile_info`
- `get_media_posts`
- `get_media_insights`
- `publish_media`
- `get_account_pages`
- `get_conversations` (requires Advanced Access)
- `get_conversation_messages` (requires Advanced Access)
- `send_dm` (requires Advanced Access)

**Facebook tools:**
- `fb_get_page_info`
- `fb_get_page_posts`
- `fb_get_post_insights`
- `fb_publish_post`
- `fb_get_conversations`
- `fb_get_conversation_messages`
- `fb_send_message`
- `fb_get_page_insights`
- `fb_get_post_comments`
- `fb_reply_to_comment`

### Step 5: Install Python Dependencies
```bash
cd external/ig-mcp && pip install -r requirements.txt
cd external/fb-mcp && pip install -r requirements.txt
```

---

## 7. Access Levels

| Level | Who Can Use | App Review Required? |
|---|---|---|
| **Standard Access** | Only people with roles on the app (developer, admin) | No |
| **Advanced Access** | Any Instagram professional account user | Yes — requires App Review + Business Verification |

**For personal use / single-account publishing:** Standard Access is sufficient. No App Review needed.

**For DMs or multi-user apps:** Advanced Access required. Must submit screen recordings showing how each permission is used + complete Business Verification.

---

## 8. Limitations & Gotchas

1. **Image format:** Instagram only supports JPEG for images. No PNG, WebP, etc.
2. **Media must be publicly hosted:** Instagram cURLs the URL — can't upload from local filesystem (except via resumable upload for videos).
3. **Token expiry:** Long-lived tokens expire after 60 days. Need automatic refresh logic.
4. **Page Publishing Authorization (PPA):** Some Pages require PPA before publishing is allowed.
5. **Rate limits are impression-based:** `4800 × impressions in last 24h`. Low-impression accounts get fewer API calls.
6. **App Review for DMs:** Instagram DM access requires Advanced Access which needs App Review with screen recordings.
7. **One Meta App covers both:** A single Business-type app can have both Instagram and Facebook products.

---

## 9. Recommendation

**Verdict: Easy enough to re-enable.** The MCP servers already exist and are production-quality. For personal account publishing:

1. Create a Meta Business App (5 minutes at developers.facebook.com)
2. Generate long-lived tokens via Graph API Explorer (5 minutes)  
3. Add env vars and wire into `nativeMcpServers` config (5 minutes)
4. Install Python deps and test (5 minutes)

**Total estimated setup:** ~20 minutes for Standard Access (personal use).  
**For Advanced Access (multi-user/DMs):** Additional time for App Review submission (days-to-weeks review cycle).

### Next Steps
- [ ] Log into developers.facebook.com and create/find existing Meta App
- [ ] Generate access tokens for your Instagram Professional Account + Facebook Page
- [ ] Store tokens in OpenZigs vault (secrets)
- [ ] Wire `ig-mcp` and `fb-mcp` into `nativeMcpServers` config
- [ ] Add tool names to `config/tools.json`
- [ ] Test with chat: "What's my Instagram profile info?" / "Post to my Facebook page"
