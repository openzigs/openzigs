"""Configuration for Reddit MCP Server."""
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class RedditMCPSettings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "case_sensitive": False, "extra": "ignore"}

    reddit_client_id: str = Field(..., description="Reddit OAuth2 client ID")
    reddit_client_secret: str = Field(..., description="Reddit OAuth2 client secret")
    reddit_username: str = Field("", description="Reddit username (for script-type apps)")
    reddit_password: str = Field("", description="Reddit password (for script-type apps)")
    reddit_user_agent: str = Field("openzigs-mcp/1.0", description="Reddit API user agent")
    reddit_api_base: str = Field("https://oauth.reddit.com", description="Reddit OAuth API base")
    mcp_server_name: str = Field("reddit-mcp-server", description="MCP server name")
    mcp_server_version: str = Field("1.0.0", description="Server version")
    log_level: str = Field("INFO", description="Log level")


_settings: Optional[RedditMCPSettings] = None


def get_settings() -> RedditMCPSettings:
    global _settings
    if _settings is None:
        _settings = RedditMCPSettings()
    return _settings
