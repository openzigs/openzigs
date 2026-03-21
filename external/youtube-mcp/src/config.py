"""Configuration for YouTube MCP Server."""
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class YouTubeMCPSettings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "case_sensitive": False, "extra": "ignore"}

    youtube_api_key: str = Field(..., description="YouTube Data API v3 key")
    youtube_channel_id: Optional[str] = Field(None, description="YouTube channel ID (auto-detected if omitted)")
    youtube_channel_handle: Optional[str] = Field(None, description="YouTube channel handle e.g. @MyCoolChannel (used to resolve channel ID without OAuth)")
    youtube_oauth_token: str = Field("", description="OAuth2 access token for write operations")
    youtube_api_base: str = Field("https://www.googleapis.com/youtube/v3", description="YouTube API base URL")
    mcp_server_name: str = Field("youtube-mcp-server", description="MCP server name")
    mcp_server_version: str = Field("1.0.0", description="Server version")
    log_level: str = Field("INFO", description="Log level")


_settings: Optional[YouTubeMCPSettings] = None


def get_settings() -> YouTubeMCPSettings:
    global _settings
    if _settings is None:
        _settings = YouTubeMCPSettings()
    return _settings
