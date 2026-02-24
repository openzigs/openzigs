"""Configuration for Twitter/X MCP Server."""
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class TwitterMCPSettings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "case_sensitive": False}

    twitter_bearer_token: str = Field(..., description="Twitter API v2 Bearer token")
    twitter_api_key: str = Field("", description="Twitter API key (for OAuth 1.0a user-context)")
    twitter_api_secret: str = Field("", description="Twitter API secret")
    twitter_access_token: str = Field("", description="Twitter OAuth 1.0a access token")
    twitter_access_token_secret: str = Field("", description="Twitter OAuth 1.0a access token secret")
    twitter_api_base: str = Field("https://api.twitter.com/2", description="Twitter API v2 base URL")
    mcp_server_name: str = Field("twitter-mcp-server", description="MCP server name")
    mcp_server_version: str = Field("1.0.0", description="Server version")
    log_level: str = Field("INFO", description="Log level")


_settings: Optional[TwitterMCPSettings] = None


def get_settings() -> TwitterMCPSettings:
    global _settings
    if _settings is None:
        _settings = TwitterMCPSettings()
    return _settings
