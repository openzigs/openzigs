"""YouTube Data API v3 client."""
import httpx
import structlog
from .config import get_settings

logger = structlog.get_logger(__name__)


class YouTubeAPIError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status


class YouTubeClient:
    """Client for YouTube Data API v3."""

    def __init__(self):
        self.settings = get_settings()
        self.base = self.settings.youtube_api_base
        self.api_key = self.settings.youtube_api_key
        self._channel_id: str | None = self.settings.youtube_channel_id

    async def _request(self, method: str, path: str, *, use_oauth: bool = False, **kwargs) -> dict:
        url = f"{self.base}/{path}"
        params = kwargs.pop("params", {})
        if not use_oauth:
            params["key"] = self.api_key
        headers = {}
        if use_oauth:
            if not self.settings.youtube_oauth_token:
                raise YouTubeAPIError("OAuth token required for write operations")
            headers["Authorization"] = f"Bearer {self.settings.youtube_oauth_token}"
        async with httpx.AsyncClient(timeout=30.0) as c:
            resp = await c.request(method, url, params=params, headers=headers, **kwargs)
        if resp.status_code >= 400:
            raise YouTubeAPIError(f"HTTP {resp.status_code}: {resp.text[:500]}", resp.status_code)
        return resp.json()

    async def _get_channel_id(self) -> str:
        if self._channel_id:
            return self._channel_id
        data = await self._request("GET", "channels", params={"part": "id", "mine": "true"}, use_oauth=True)
        items = data.get("items", [])
        if not items:
            raise YouTubeAPIError("No channel found for authenticated user")
        self._channel_id = items[0]["id"]
        return self._channel_id

    async def get_channel_info(self, channel_id: str | None = None) -> dict:
        cid = channel_id or await self._get_channel_id()
        return await self._request("GET", "channels", params={"part": "snippet,statistics,contentDetails", "id": cid})

    async def get_channel_videos(self, max_results: int = 25, page_token: str | None = None) -> dict:
        cid = await self._get_channel_id()
        params: dict = {"part": "snippet", "channelId": cid, "order": "date", "maxResults": str(max_results), "type": "video"}
        if page_token:
            params["pageToken"] = page_token
        return await self._request("GET", "search", params=params)

    async def get_video_details(self, video_id: str) -> dict:
        return await self._request("GET", "videos", params={"part": "snippet,statistics,contentDetails", "id": video_id})

    async def get_video_comments(self, video_id: str, max_results: int = 20) -> dict:
        return await self._request("GET", "commentThreads", params={"part": "snippet,replies", "videoId": video_id, "maxResults": str(max_results), "order": "relevance"})

    async def reply_to_comment(self, parent_id: str, text: str) -> dict:
        return await self._request("POST", "comments", use_oauth=True, params={"part": "snippet"}, json={"snippet": {"parentId": parent_id, "textOriginal": text}})

    async def search_videos(self, query: str, max_results: int = 10) -> dict:
        return await self._request("GET", "search", params={"part": "snippet", "q": query, "maxResults": str(max_results), "type": "video"})

    async def get_channel_analytics(self) -> dict:
        """Get channel statistics (uses Data API, not Analytics API)."""
        cid = await self._get_channel_id()
        data = await self._request("GET", "channels", params={"part": "statistics", "id": cid})
        items = data.get("items", [])
        return items[0].get("statistics", {}) if items else {}
