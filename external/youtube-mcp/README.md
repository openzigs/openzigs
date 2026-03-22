# YouTube MCP Server

A Model Context Protocol (MCP) server that provides integration with the YouTube Data API v3, enabling AI applications to interact with channels, videos, and comments programmatically.

## Features

### Tools

| Tool | Description |
|------|-------------|
| `yt_get_channel_info` | Get YouTube channel info (subscribers, views, description) |
| `yt_get_channel_videos` | List recent videos from a channel |
| `yt_get_video_details` | Get detailed info for a video (stats, description, duration) |
| `yt_get_video_comments` | Get top comments on a video |
| `yt_reply_to_comment` | Reply to a YouTube comment (requires OAuth) |
| `yt_search_videos` | Search YouTube videos by query |
| `yt_get_channel_analytics` | Get channel statistics (views, subscribers, video count) |
| `yt_upload_video` | Upload a video to YouTube (requires OAuth) |

## Prerequisites

- Python 3.10+
- Google Cloud project with YouTube Data API v3 enabled
- YouTube API key (read-only) or OAuth2 token (read/write)

## Installation

```bash
cd external/youtube-mcp
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Create a `.env` file in the `youtube-mcp` directory:

```env
YOUTUBE_API_KEY=your_api_key
# Optional
YOUTUBE_CHANNEL_ID=your_channel_id
YOUTUBE_CHANNEL_HANDLE=@YourChannel
# Required for write operations (upload, reply)
YOUTUBE_OAUTH_TOKEN=your_oauth_token
```

## Usage

```bash
python -m src.youtube_mcp_server
```

The server communicates over stdio using the MCP protocol.

## License

[FSL-1.1-MIT](LICENSE.md) — Copyright 2026 Zylos Labs LLC
