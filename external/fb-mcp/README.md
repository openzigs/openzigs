# Facebook MCP Server

A Model Context Protocol (MCP) server that provides integration with Facebook's Graph API, enabling AI applications to interact with Facebook Pages programmatically.

## Features

### Tools

| Tool | Description |
|------|-------------|
| `fb_get_page_info` | Get Facebook Page profile info (name, followers, category, etc.) |
| `fb_get_page_posts` | Get recent posts from the Facebook Page with engagement metrics |
| `fb_get_post_insights` | Get detailed insights for a specific Facebook post |
| `fb_publish_post` | Publish a new post to the Facebook Page |
| `fb_get_conversations` | List Facebook Page Messenger conversations |
| `fb_get_conversation_messages` | Get messages from a Messenger conversation |
| `fb_send_message` | Send a Messenger reply to a user (within 24h window) |
| `fb_get_page_insights` | Get Page-level analytics (impressions, engaged users, fan adds) |
| `fb_get_post_comments` | Get comments on a Facebook Page post |
| `fb_reply_to_comment` | Reply to a comment on a Facebook Page post |

## Prerequisites

- Python 3.10+
- Facebook Developer account
- Facebook Page access token with appropriate permissions

## Installation

```bash
cd external/fb-mcp
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Create a `.env` file in the `fb-mcp` directory:

```env
FACEBOOK_PAGE_TOKEN=your_page_access_token
FACEBOOK_APP_ID=your_app_id
FACEBOOK_APP_SECRET=your_app_secret
# Optional — auto-detected if omitted
FACEBOOK_PAGE_ID=your_page_id
```

## Usage

```bash
python -m src.facebook_mcp_server
```

The server communicates over stdio using the MCP protocol.

## License

[FSL-1.1-MIT](LICENSE.md) — Copyright 2026 Zylos Labs LLC
