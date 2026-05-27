#!/usr/bin/env python3
"""Twitter/X MCP Server — Model Context Protocol server for Twitter API v2."""
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
from .twitter_client import TwitterAPIError, TwitterClient

logger = structlog.get_logger(__name__)
client: TwitterClient | None = None


def _result(success: bool, data: Any = None, error: str | None = None) -> str:
    return json.dumps({"success": success, "data": data, "error": error, "timestamp": datetime.now(timezone.utc).isoformat()}, indent=2, default=str)


class TwitterMCPServer:
    def __init__(self):
        self.settings = get_settings()
        self.server = Server(self.settings.mcp_server_name)
        self._setup_handlers()

    def _setup_handlers(self):
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            return [
                Tool(name="twitter_get_me", description="Get authenticated Twitter user profile", inputSchema={"type": "object", "properties": {}}),
                Tool(name="twitter_get_user_tweets", description="Get recent tweets from a user", inputSchema={"type": "object", "properties": {"user_id": {"type": "string"}, "max_results": {"type": "integer", "default": 10, "maximum": 100}}, "required": ["user_id"]}),
                Tool(name="twitter_search_tweets", description="Search recent tweets by query", inputSchema={"type": "object", "properties": {"query": {"type": "string", "description": "Search query (Twitter search syntax)"}, "max_results": {"type": "integer", "default": 10, "maximum": 100}}, "required": ["query"]}),
                Tool(name="twitter_get_tweet", description="Get a single tweet by ID", inputSchema={"type": "object", "properties": {"tweet_id": {"type": "string"}}, "required": ["tweet_id"]}),
                Tool(name="twitter_post_tweet", description="Post a new tweet (requires OAuth 1.0a)", inputSchema={"type": "object", "properties": {"text": {"type": "string", "maxLength": 280}, "reply_to": {"type": "string", "description": "Tweet ID to reply to"}}, "required": ["text"]}),
                Tool(name="twitter_get_dm_events", description="Get recent DM events", inputSchema={"type": "object", "properties": {"max_results": {"type": "integer", "default": 20}}}),
                Tool(name="twitter_send_dm", description="Send a direct message", inputSchema={"type": "object", "properties": {"participant_id": {"type": "string", "description": "Twitter user ID"}, "text": {"type": "string"}}, "required": ["participant_id", "text"]}),
                Tool(name="twitter_get_user", description="Look up a user by username", inputSchema={"type": "object", "properties": {"username": {"type": "string"}}, "required": ["username"]}),
                Tool(name="twitter_get_mentions", description="Get recent tweets mentioning a user (requires OAuth 1.0a)", inputSchema={"type": "object", "properties": {"user_id": {"type": "string", "description": "Twitter user ID"}, "max_results": {"type": "integer", "default": 20, "maximum": 100}, "since_id": {"type": "string", "description": "Only return tweets after this tweet ID"}}, "required": ["user_id"]}),
                Tool(name="twitter_search_replies", description="Search for recent replies to a username using search/recent", inputSchema={"type": "object", "properties": {"username": {"type": "string", "description": "Twitter username (without @)"}, "max_results": {"type": "integer", "default": 20, "maximum": 100}}, "required": ["username"]}),
                Tool(name="twitter_post_analytics", description="Get analytics for a tweet (likes, retweets, replies, quotes, impressions). Free tier returns public_metrics only.", inputSchema={"type": "object", "properties": {"tweet_id": {"type": "string"}}, "required": ["tweet_id"]}),
                Tool(name="twitter_account_analytics", description="Get account-level analytics (followers, following, tweet count). Omit username for authenticated user.", inputSchema={"type": "object", "properties": {"username": {"type": "string"}}}),
            ]

        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> Sequence[TextContent]:
            global client
            if not client:
                client = TwitterClient()
            try:
                if name == "twitter_get_me":
                    data = await client.get_me()
                elif name == "twitter_get_user_tweets":
                    data = await client.get_user_tweets(arguments["user_id"], arguments.get("max_results", 10))
                elif name == "twitter_search_tweets":
                    data = await client.search_tweets(arguments["query"], arguments.get("max_results", 10))
                elif name == "twitter_get_tweet":
                    data = await client.get_tweet(arguments["tweet_id"])
                elif name == "twitter_post_tweet":
                    data = await client.post_tweet(arguments["text"], arguments.get("reply_to"))
                elif name == "twitter_get_dm_events":
                    data = await client.get_dm_events(arguments.get("max_results", 20))
                elif name == "twitter_send_dm":
                    data = await client.send_dm(arguments["participant_id"], arguments["text"])
                elif name == "twitter_get_user":
                    data = await client.get_user_by_username(arguments["username"])
                elif name == "twitter_get_mentions":
                    data = await client.get_mentions(arguments["user_id"], arguments.get("max_results", 20), arguments.get("since_id"))
                elif name == "twitter_search_replies":
                    data = await client.search_replies(arguments["username"], arguments.get("max_results", 20))
                elif name == "twitter_post_analytics":
                    data = await client.get_post_analytics(arguments["tweet_id"])
                elif name == "twitter_account_analytics":
                    data = await client.get_account_analytics(arguments.get("username"))
                else:
                    return [TextContent(type="text", text=_result(False, error=f"Unknown tool: {name}"))]
                return [TextContent(type="text", text=_result(True, data=data))]
            except TwitterAPIError as e:
                return [TextContent(type="text", text=_result(False, error=f"Twitter API error: {e.message}"))]
            except Exception as e:
                logger.error("Tool error", tool=name, error=str(e))
                return [TextContent(type="text", text=_result(False, error=str(e)))]

    async def run(self):
        global client
        client = TwitterClient()
        async with stdio_server() as (read_stream, write_stream):
            await self.server.run(read_stream, write_stream, InitializationOptions(
                server_name=self.settings.mcp_server_name,
                server_version=self.settings.mcp_server_version,
                capabilities=self.server.get_capabilities(notification_options=NotificationOptions(), experimental_capabilities={}),
            ))


async def main():
    import logging
    import sys
    settings = get_settings()
    # ALL logging MUST go to stderr — stdout is reserved for the MCP JSON protocol
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        stream=sys.stderr,
        force=True,
    )
    # Ensure httpx and other library loggers also go to stderr and don't propagate
    for name in ("httpx", "httpcore", "mcp"):
        lib_logger = logging.getLogger(name)
        lib_logger.handlers.clear()
        handler = logging.StreamHandler(sys.stderr)
        lib_logger.addHandler(handler)
        lib_logger.propagate = False

    # Configure structlog to write to stderr (default PrintLogger writes to stdout!)
    structlog.configure(
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
    )
    await TwitterMCPServer().run()


if __name__ == "__main__":
    asyncio.run(main())
