# Twitter/X MCP Server

A Model Context Protocol (MCP) server that provides integration with the Twitter/X API v2, enabling AI applications to interact with tweets, users, and direct messages programmatically.

## Features

### Tools

| Tool | Description |
|------|-------------|
| `twitter_get_me` | Get authenticated Twitter user profile |
| `twitter_get_user_tweets` | Get recent tweets from a user |
| `twitter_search_tweets` | Search recent tweets by query (Twitter search syntax) |
| `twitter_get_tweet` | Get a single tweet by ID |
| `twitter_post_tweet` | Post a new tweet (requires OAuth 1.0a) |
| `twitter_get_dm_events` | Get recent DM events |
| `twitter_send_dm` | Send a direct message |
| `twitter_get_user` | Look up a user by username |
| `twitter_get_mentions` | Get recent tweets mentioning a user (requires OAuth 1.0a) |
| `twitter_search_replies` | Search for recent replies to a username |

## Prerequisites

- Python 3.10+
- Twitter Developer account with API v2 access
- Twitter Bearer token (read-only) or OAuth 1.0a credentials (read/write)

## Installation

```bash
cd external/twitter-mcp
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Create a `.env` file in the `twitter-mcp` directory:

```env
TWITTER_BEARER_TOKEN=your_bearer_token
# Optional — required for posting tweets, DMs, and mentions
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret
```

## Usage

```bash
python -m src.twitter_mcp_server
```

The server communicates over stdio using the MCP protocol.

## License

[FSL-1.1-MIT](LICENSE.md) — Copyright 2026 Zylos Labs LLC
