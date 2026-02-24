"""Configuration for LinkedIn MCP Server."""
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class LinkedInMCPSettings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "case_sensitive": False}

    linkedin_access_token: str = Field(..., description="LinkedIn OAuth2 access token")
    linkedin_person_id: str = Field("", description="LinkedIn person URN (e.g. urn:li:person:xxx)")
    linkedin_org_id: str = Field("", description="LinkedIn organization ID for company pages")
    linkedin_api_base: str = Field("https://api.linkedin.com/v2", description="LinkedIn API v2 base URL")
    mcp_server_name: str = Field("linkedin-mcp-server", description="MCP server name")
    mcp_server_version: str = Field("1.0.0", description="Server version")
    log_level: str = Field("INFO", description="Log level")


_settings: Optional[LinkedInMCPSettings] = None


def get_settings() -> LinkedInMCPSettings:
    global _settings
    if _settings is None:
        _settings = LinkedInMCPSettings()
    return _settings
