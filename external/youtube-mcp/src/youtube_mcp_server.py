#!/usr/bin/env python3
"""YouTube MCP Server — Model Context Protocol server for YouTube Data API v3."""
import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Sequence

import structlog
from mcp.server import Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .config import get_settings
from .youtube_client import YouTubeAPIError, YouTubeClient

logger = structlog.get_logger(__name__)
client: YouTubeClient | None = None


def _result(success: bool, data: Any = None, error: str | None = None) -> str:
    return json.dumps({"success": success, "data": data, "error": error, "timestamp": datetime.now(timezone.utc).isoformat()}, indent=2, default=str)


class YouTubeMCPServer:
    def __init__(self):
        self.settings = get_settings()
        self.server = Server(self.settings.mcp_server_name)
        self._setup_handlers()

    def _setup_handlers(self):
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            return [
                Tool(name="yt_get_channel_info", description="Get YouTube channel info (subscribers, views, description)", inputSchema={"type": "object", "properties": {"channel_id": {"type": "string", "description": "Channel ID (optional, uses authenticated channel)"}}}),
                Tool(name="yt_get_channel_videos", description="List recent videos from a channel", inputSchema={"type": "object", "properties": {"max_results": {"type": "integer", "default": 25, "maximum": 50}, "page_token": {"type": "string"}}}),
                Tool(name="yt_get_video_details", description="Get detailed info for a video (stats, description, duration)", inputSchema={"type": "object", "properties": {"video_id": {"type": "string"}}, "required": ["video_id"]}),
                Tool(name="yt_get_video_comments", description="Get top comments on a video", inputSchema={"type": "object", "properties": {"video_id": {"type": "string"}, "max_results": {"type": "integer", "default": 20}}, "required": ["video_id"]}),
                Tool(name="yt_reply_to_comment", description="Reply to a YouTube comment (requires OAuth)", inputSchema={"type": "object", "properties": {"parent_id": {"type": "string", "description": "Comment ID to reply to"}, "text": {"type": "string"}}, "required": ["parent_id", "text"]}),
                Tool(name="yt_search_videos", description="Search YouTube videos by query", inputSchema={"type": "object", "properties": {"query": {"type": "string"}, "max_results": {"type": "integer", "default": 10}}, "required": ["query"]}),
                Tool(name="yt_get_channel_analytics", description="Get channel statistics (views, subscribers, video count)", inputSchema={"type": "object", "properties": {}}),
            ]

        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> Sequence[TextContent]:
            global client
            if not client:
                client = YouTubeClient()
            try:
                if name == "yt_get_channel_info":
                    data = await client.get_channel_info(arguments.get("channel_id"))
                elif name == "yt_get_channel_videos":
                    data = await client.get_channel_videos(arguments.get("max_results", 25), arguments.get("page_token"))
                elif name == "yt_get_video_details":
                    data = await client.get_video_details(arguments["video_id"])
                elif name == "yt_get_video_comments":
                    data = await client.get_video_comments(arguments["video_id"], arguments.get("max_results", 20))
                elif name == "yt_reply_to_comment":
                    data = await client.reply_to_comment(arguments["parent_id"], arguments["text"])
                elif name == "yt_search_videos":
                    data = await client.search_videos(arguments["query"], arguments.get("max_results", 10))
                elif name == "yt_get_channel_analytics":
                    data = await client.get_channel_analytics()
                else:
                    return [TextContent(type="text", text=_result(False, error=f"Unknown tool: {name}"))]
                return [TextContent(type="text", text=_result(True, data=data))]
            except YouTubeAPIError as e:
                return [TextContent(type="text", text=_result(False, error=f"YouTube API error: {e.message}"))]
            except Exception as e:
                logger.error("Tool error", tool=name, error=str(e))
                return [TextContent(type="text", text=_result(False, error=str(e)))]

    async def run(self):
        global client
        client = YouTubeClient()
        async with stdio_server() as (read_stream, write_stream):
            await self.server.run(read_stream, write_stream, InitializationOptions(
                server_name=self.settings.mcp_server_name,
                server_version=self.settings.mcp_server_version,
                capabilities=self.server.get_capabilities(notification_options=NotificationOptions(), experimental_capabilities={}),
            ))


async def main():
    import logging
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level))
    await YouTubeMCPServer().run()


if __name__ == "__main__":
    asyncio.run(main())
