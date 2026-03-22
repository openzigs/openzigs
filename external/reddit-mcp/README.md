# Reddit MCP Server

A Model Context Protocol (MCP) server that provides integration with Reddit's API, enabling AI applications to interact with subreddits, posts, and messages programmatically.

## Features

### Tools

| Tool | Description |
|------|-------------|
| `reddit_get_me` | Get authenticated Reddit user profile |
| `reddit_get_subreddit_posts` | Get posts from a subreddit (hot, new, top, rising) |
| `reddit_get_post_comments` | Get comments on a Reddit post |
| `reddit_submit_post` | Submit a new post to a subreddit (text or link) |
| `reddit_reply_to_comment` | Reply to a Reddit comment or post |
| `reddit_search` | Search Reddit posts by query |
| `reddit_get_inbox` | Get Reddit inbox messages |
| `reddit_send_message` | Send a Reddit private message |

## Prerequisites

- Python 3.10+
- Reddit developer account
- Reddit OAuth2 credentials (client ID and secret)

## Installation

```bash
cd external/reddit-mcp
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Create a `.env` file in the `reddit-mcp` directory:

```env
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
# Optional — for script-type apps
REDDIT_USERNAME=your_username
REDDIT_PASSWORD=your_password
```

## Usage

```bash
python -m src.reddit_mcp_server
```

The server communicates over stdio using the MCP protocol.

## License

[FSL-1.1-MIT](LICENSE.md) — Copyright 2026 Zylos Labs LLC
