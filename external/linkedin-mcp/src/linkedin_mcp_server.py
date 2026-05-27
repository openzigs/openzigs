#!/usr/bin/env python3
"""LinkedIn MCP Server — Model Context Protocol server for LinkedIn API v2."""
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
from .linkedin_client import LinkedInAPIError, LinkedInClient

logger = structlog.get_logger(__name__)
client: LinkedInClient | None = None


def _result(success: bool, data: Any = None, error: str | None = None) -> str:
    return json.dumps({"success": success, "data": data, "error": error, "timestamp": datetime.now(timezone.utc).isoformat()}, indent=2, default=str)


class LinkedInMCPServer:
    def __init__(self):
        self.settings = get_settings()
        self.server = Server(self.settings.mcp_server_name)
        self._setup_handlers()

    def _setup_handlers(self):
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            return [
                Tool(name="linkedin_get_profile", description="Get authenticated LinkedIn user profile", inputSchema={"type": "object", "properties": {}}),
                Tool(name="linkedin_get_posts", description="Get recent posts from LinkedIn profile or company", inputSchema={"type": "object", "properties": {"author_urn": {"type": "string", "description": "Author URN (optional, uses authenticated user)"}, "count": {"type": "integer", "default": 20}}}),
                Tool(name="linkedin_create_post", description="Publish a text post on LinkedIn", inputSchema={"type": "object", "properties": {"text": {"type": "string", "description": "Post text content"}, "visibility": {"type": "string", "enum": ["PUBLIC", "CONNECTIONS"], "default": "PUBLIC"}}, "required": ["text"]}),
                Tool(name="linkedin_get_company", description="Get LinkedIn company/organization page info", inputSchema={"type": "object", "properties": {"org_id": {"type": "string", "description": "Organization ID (optional, uses configured org)"}}}),
                Tool(name="linkedin_send_message", description="Send a LinkedIn direct message", inputSchema={"type": "object", "properties": {"recipient_urn": {"type": "string", "description": "Recipient URN (urn:li:person:xxx)"}, "text": {"type": "string"}}, "required": ["recipient_urn", "text"]}),
                Tool(name="linkedin_get_conversations", description="List recent LinkedIn message conversations", inputSchema={"type": "object", "properties": {"count": {"type": "integer", "default": 20}}}),
                Tool(name="linkedin_get_post_comments", description="Get comments on a LinkedIn post", inputSchema={"type": "object", "properties": {"post_urn": {"type": "string", "description": "Post URN (e.g. urn:li:share:xxx or urn:li:ugcPost:xxx)"}, "count": {"type": "integer", "default": 20}}, "required": ["post_urn"]}),
                Tool(name="linkedin_reply_to_comment", description="Reply to a comment on a LinkedIn post", inputSchema={"type": "object", "properties": {"post_urn": {"type": "string", "description": "Post URN"}, "comment_urn": {"type": "string", "description": "Comment URN to reply to"}, "text": {"type": "string", "description": "Reply text"}}, "required": ["post_urn", "comment_urn", "text"]}),
                Tool(name="linkedin_post_analytics", description="Get analytics for a LinkedIn post (impressions, clicks, engagement). Only available for organization-owned posts.", inputSchema={"type": "object", "properties": {"post_urn": {"type": "string"}}, "required": ["post_urn"]}),
                Tool(name="linkedin_profile_analytics", description="Get profile/page-level analytics (follower count, growth). Organization-level via organization_id; member-level uses networkSizes.", inputSchema={"type": "object", "properties": {"organization_id": {"type": "string"}}}),
            ]

        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> Sequence[TextContent]:
            global client
            if not client:
                client = LinkedInClient()
            try:
                if name == "linkedin_get_profile":
                    data = await client.get_profile()
                elif name == "linkedin_get_posts":
                    data = await client.get_posts(arguments.get("author_urn"), arguments.get("count", 20))
                elif name == "linkedin_create_post":
                    data = await client.create_text_post(arguments["text"], arguments.get("visibility", "PUBLIC"))
                elif name == "linkedin_get_company":
                    data = await client.get_company_info(arguments.get("org_id"))
                elif name == "linkedin_send_message":
                    data = await client.send_message(arguments["recipient_urn"], arguments["text"])
                elif name == "linkedin_get_conversations":
                    data = await client.get_conversations(arguments.get("count", 20))
                elif name == "linkedin_get_post_comments":
                    data = await client.get_post_comments(arguments["post_urn"], arguments.get("count", 20))
                elif name == "linkedin_reply_to_comment":
                    data = await client.reply_to_comment(arguments["post_urn"], arguments["comment_urn"], arguments["text"])
                elif name == "linkedin_post_analytics":
                    data = await client.get_post_analytics(arguments["post_urn"])
                elif name == "linkedin_profile_analytics":
                    data = await client.get_profile_analytics(arguments.get("organization_id"))
                else:
                    return [TextContent(type="text", text=_result(False, error=f"Unknown tool: {name}"))]
                return [TextContent(type="text", text=_result(True, data=data))]
            except LinkedInAPIError as e:
                return [TextContent(type="text", text=_result(False, error=f"LinkedIn API error: {e.message}"))]
            except Exception as e:
                logger.error("Tool error", tool=name, error=str(e))
                return [TextContent(type="text", text=_result(False, error=str(e)))]

    async def run(self):
        global client
        client = LinkedInClient()
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
    logging.basicConfig(level=getattr(logging, settings.log_level.upper()), stream=sys.stderr)
    await LinkedInMCPServer().run()


if __name__ == "__main__":
    asyncio.run(main())
