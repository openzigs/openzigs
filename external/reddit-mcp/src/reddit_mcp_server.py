#!/usr/bin/env python3
"""Reddit MCP Server — Model Context Protocol server for Reddit API."""
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
from .reddit_client import RedditAPIError, RedditClient

logger = structlog.get_logger(__name__)
client: RedditClient | None = None


def _result(success: bool, data: Any = None, error: str | None = None) -> str:
    return json.dumps({"success": success, "data": data, "error": error, "timestamp": datetime.now(timezone.utc).isoformat()}, indent=2, default=str)


class RedditMCPServer:
    def __init__(self):
        self.settings = get_settings()
        self.server = Server(self.settings.mcp_server_name)
        self._setup_handlers()

    def _setup_handlers(self):
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            return [
                Tool(name="reddit_get_me", description="Get authenticated Reddit user profile", inputSchema={"type": "object", "properties": {}}),
                Tool(name="reddit_get_subreddit_posts", description="Get posts from a subreddit", inputSchema={"type": "object", "properties": {"subreddit": {"type": "string"}, "sort": {"type": "string", "enum": ["hot", "new", "top", "rising"], "default": "hot"}, "limit": {"type": "integer", "default": 25}}, "required": ["subreddit"]}),
                Tool(name="reddit_get_post_comments", description="Get comments on a Reddit post", inputSchema={"type": "object", "properties": {"subreddit": {"type": "string"}, "post_id": {"type": "string"}, "limit": {"type": "integer", "default": 25}}, "required": ["subreddit", "post_id"]}),
                Tool(name="reddit_submit_post", description="Submit a new post to a subreddit", inputSchema={"type": "object", "properties": {"subreddit": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string", "description": "Self-post text"}, "url": {"type": "string", "description": "Link URL (mutually exclusive with text)"}}, "required": ["subreddit", "title"]}),
                Tool(name="reddit_reply_to_comment", description="Reply to a Reddit comment or post", inputSchema={"type": "object", "properties": {"thing_id": {"type": "string", "description": "Reddit fullname (t1_xxx for comment, t3_xxx for post)"}, "text": {"type": "string"}}, "required": ["thing_id", "text"]}),
                Tool(name="reddit_search", description="Search Reddit posts", inputSchema={"type": "object", "properties": {"query": {"type": "string"}, "subreddit": {"type": "string", "description": "Restrict to subreddit (optional)"}, "limit": {"type": "integer", "default": 25}}, "required": ["query"]}),
                Tool(name="reddit_get_inbox", description="Get Reddit inbox messages", inputSchema={"type": "object", "properties": {"limit": {"type": "integer", "default": 25}}}),
                Tool(name="reddit_send_message", description="Send a Reddit private message", inputSchema={"type": "object", "properties": {"recipient": {"type": "string"}, "subject": {"type": "string"}, "text": {"type": "string"}}, "required": ["recipient", "subject", "text"]}),
            ]

        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> Sequence[TextContent]:
            global client
            if not client:
                client = RedditClient()
            try:
                if name == "reddit_get_me":
                    data = await client.get_me()
                elif name == "reddit_get_subreddit_posts":
                    data = await client.get_subreddit_posts(arguments["subreddit"], arguments.get("sort", "hot"), arguments.get("limit", 25))
                elif name == "reddit_get_post_comments":
                    data = await client.get_post_comments(arguments["subreddit"], arguments["post_id"], arguments.get("limit", 25))
                elif name == "reddit_submit_post":
                    data = await client.submit_post(arguments["subreddit"], arguments["title"], arguments.get("text"), arguments.get("url"))
                elif name == "reddit_reply_to_comment":
                    data = await client.reply_to_comment(arguments["thing_id"], arguments["text"])
                elif name == "reddit_search":
                    data = await client.search(arguments["query"], arguments.get("subreddit"), arguments.get("limit", 25))
                elif name == "reddit_get_inbox":
                    data = await client.get_inbox(arguments.get("limit", 25))
                elif name == "reddit_send_message":
                    data = await client.send_message(arguments["recipient"], arguments["subject"], arguments["text"])
                else:
                    return [TextContent(type="text", text=_result(False, error=f"Unknown tool: {name}"))]
                return [TextContent(type="text", text=_result(True, data=data))]
            except RedditAPIError as e:
                return [TextContent(type="text", text=_result(False, error=f"Reddit API error: {e.message}"))]
            except Exception as e:
                logger.error("Tool error", tool=name, error=str(e))
                return [TextContent(type="text", text=_result(False, error=str(e)))]

    async def run(self):
        global client
        client = RedditClient()
        async with stdio_server() as (read_stream, write_stream):
            await self.server.run(read_stream, write_stream, InitializationOptions(
                server_name=self.settings.mcp_server_name,
                server_version=self.settings.mcp_server_version,
                capabilities=self.server.get_capabilities(notification_options=NotificationOptions(), experimental_capabilities={}),
            ))


async def main():
    import logging
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper()))
    await RedditMCPServer().run()


if __name__ == "__main__":
    asyncio.run(main())
