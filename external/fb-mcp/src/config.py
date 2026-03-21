"""Configuration for Facebook/Meta MCP Server."""
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class FacebookMCPSettings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "case_sensitive": False, "extra": "ignore"}

    facebook_page_token: str = Field(..., description="Facebook Page access token")
    facebook_app_id: str = Field("", description="Facebook App ID")
    facebook_app_secret: str = Field("", description="Facebook App secret")
    facebook_page_id: Optional[str] = Field(None, description="Facebook Page ID (auto-detected if omitted)")
    meta_graph_api_version: str = Field("v21.0", description="Graph API version")
    meta_graph_api_base: str = Field("https://graph.facebook.com", description="Graph API base URL")
    mcp_server_name: str = Field("facebook-mcp-server", description="MCP server name")
    mcp_server_version: str = Field("1.0.0", description="MCP server version")
    log_level: str = Field("INFO", description="Log level")


_settings: Optional[FacebookMCPSettings] = None


def get_settings() -> FacebookMCPSettings:
    global _settings
    if _settings is None:
        _settings = FacebookMCPSettings()
    return _settings
