#!/usr/bin/env python3
"""Facebook/Meta MCP Server — Model Context Protocol server for Facebook Pages API."""
import asyncio
import json
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Sequence

import structlog
from mcp.server import Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .config import get_settings
from .facebook_client import FacebookAPIError, FacebookClient

logger = structlog.get_logger(__name__)
client: FacebookClient | None = None


def _result(success: bool, data: Any = None, error: str | None = None) -> str:
    return json.dumps({"success": success, "data": data, "error": error, "timestamp": datetime.now(timezone.utc).isoformat()}, indent=2, default=str)


class FacebookMCPServer:
    def __init__(self):
        self.settings = get_settings()
        self.server = Server(self.settings.mcp_server_name)
        self._setup_handlers()

    def _setup_handlers(self):
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            return [
                Tool(name="fb_get_page_info", description="Get Facebook Page profile info (name, followers, category, etc.)", inputSchema={"type": "object", "properties": {}}),
                Tool(name="fb_get_page_posts", description="Get recent posts from the Facebook Page with engagement metrics", inputSchema={"type": "object", "properties": {"limit": {"type": "integer", "description": "Number of posts (max 100)", "default": 25}, "after": {"type": "string", "description": "Pagination cursor"}}}),
                Tool(name="fb_get_post_insights", description="Get detailed insights for a specific Facebook post", inputSchema={"type": "object", "properties": {"post_id": {"type": "string", "description": "Facebook post ID"}}, "required": ["post_id"]}),
                Tool(name="fb_publish_post", description="Publish a new post to the Facebook Page", inputSchema={"type": "object", "properties": {"message": {"type": "string", "description": "Post text content"}, "link": {"type": "string", "description": "Optional URL to share"}}, "required": ["message"]}),
                Tool(name="fb_get_conversations", description="List Facebook Page Messenger conversations", inputSchema={"type": "object", "properties": {"limit": {"type": "integer", "description": "Number of conversations (max 100)", "default": 25}}}),
                Tool(name="fb_get_conversation_messages", description="Get messages from a Messenger conversation", inputSchema={"type": "object", "properties": {"conversation_id": {"type": "string", "description": "Conversation ID"}, "limit": {"type": "integer", "default": 25}}, "required": ["conversation_id"]}),
                Tool(name="fb_send_message", description="Send a Messenger reply to a user (within 24h window)", inputSchema={"type": "object", "properties": {"recipient_id": {"type": "string", "description": "Recipient Page-scoped user ID"}, "message": {"type": "string", "description": "Message text (max 2000 chars)", "maxLength": 2000}}, "required": ["recipient_id", "message"]}),
                Tool(name="fb_get_page_insights", description="Get Page-level analytics (impressions, engaged users, fan adds)", inputSchema={"type": "object", "properties": {"period": {"type": "string", "enum": ["day", "week", "days_28"], "default": "day"}}}),
                Tool(name="fb_get_post_comments", description="Get comments on a Facebook Page post", inputSchema={"type": "object", "properties": {"post_id": {"type": "string", "description": "Facebook post ID"}, "limit": {"type": "integer", "default": 25}}, "required": ["post_id"]}),
                Tool(name="fb_reply_to_comment", description="Reply to a comment on a Facebook Page post", inputSchema={"type": "object", "properties": {"comment_id": {"type": "string", "description": "Comment ID to reply to"}, "message": {"type": "string", "description": "Reply text"}}, "required": ["comment_id", "message"]}),
            ]

        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> Sequence[TextContent]:
            global client
            if not client:
                client = FacebookClient()
            try:
                if name == "fb_get_page_info":
                    data = await client.get_page_info()
                elif name == "fb_get_page_posts":
                    data = await client.get_page_posts(arguments.get("limit", 25), arguments.get("after"))
                elif name == "fb_get_post_insights":
                    data = await client.get_post_insights(arguments["post_id"])
                elif name == "fb_publish_post":
                    data = await client.publish_post(arguments["message"], arguments.get("link"))
                elif name == "fb_get_conversations":
                    data = await client.get_conversations(arguments.get("limit", 25))
                elif name == "fb_get_conversation_messages":
                    data = await client.get_conversation_messages(arguments["conversation_id"], arguments.get("limit", 25))
                elif name == "fb_send_message":
                    data = await client.send_message(arguments["recipient_id"], arguments["message"])
                elif name == "fb_get_page_insights":
                    data = await client.get_page_insights(arguments.get("period", "day"))
                elif name == "fb_get_post_comments":
                    data = await client.get_post_comments(arguments["post_id"], arguments.get("limit", 25))
                elif name == "fb_reply_to_comment":
                    data = await client.reply_to_comment(arguments["comment_id"], arguments["message"])
                else:
                    return [TextContent(type="text", text=_result(False, error=f"Unknown tool: {name}"))]
                return [TextContent(type="text", text=_result(True, data=data))]
            except FacebookAPIError as e:
                return [TextContent(type="text", text=_result(False, error=f"Facebook API error: {e.message}"))]
            except Exception as e:
                logger.error("Tool execution error", tool=name, error=str(e))
                return [TextContent(type="text", text=_result(False, error=str(e)))]

    async def run(self):
        global client
        client = FacebookClient()

        # Proactively refresh token if it's expiring soon
        try:
            refreshed = await client.refresh_token_if_needed()
            if refreshed:
                logger.info("Facebook page token was refreshed on startup")
        except FacebookAPIError as e:
            logger.error(
                "Facebook token is expired or invalid — "
                "please generate a new long-lived token from "
                "https://developers.facebook.com/tools/explorer/",
                error=str(e),
            )
            sys.exit(1)

        # Validate token
        try:
            is_valid = await client.validate_token()
            if not is_valid:
                logger.error("Invalid Facebook page token")
                sys.exit(1)
            logger.info("Facebook page token validated successfully")
        except Exception as e:
            logger.error("Failed to validate Facebook token", error=str(e))
            sys.exit(1)

        async with stdio_server() as (read_stream, write_stream):
            await self.server.run(read_stream, write_stream, InitializationOptions(
                server_name=self.settings.mcp_server_name,
                server_version=self.settings.mcp_server_version,
                capabilities=self.server.get_capabilities(notification_options=NotificationOptions(), experimental_capabilities={}),
            ))


async def main():
    import logging
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper()), stream=sys.stderr)
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    server = FacebookMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
