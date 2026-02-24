"""Facebook Graph API client."""
import httpx
import structlog
from .config import get_settings

logger = structlog.get_logger(__name__)


class FacebookAPIError(Exception):
    def __init__(self, message: str, error_code: int = 0, error_subcode: int = 0):
        super().__init__(message)
        self.message = message
        self.error_code = error_code
        self.error_subcode = error_subcode


class FacebookClient:
    """Client for Facebook Graph API."""

    def __init__(self):
        self.settings = get_settings()
        self.base_url = f"{self.settings.meta_graph_api_base}/{self.settings.meta_graph_api_version}"
        self.token = self.settings.facebook_page_token
        self._page_id: str | None = self.settings.facebook_page_id

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        params = kwargs.pop("params", {})
        params["access_token"] = self.token
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, f"{self.base_url}/{path}", params=params, **kwargs)
        data = resp.json()
        if "error" in data:
            err = data["error"]
            raise FacebookAPIError(err.get("message", "Unknown"), err.get("code", 0), err.get("error_subcode", 0))
        return data

    async def _get_page_id(self) -> str:
        if self._page_id:
            return self._page_id
        data = await self._request("GET", "me", params={"fields": "id,name"})
        self._page_id = data["id"]
        return self._page_id

    async def get_page_info(self) -> dict:
        page_id = await self._get_page_id()
        fields = "id,name,about,category,fan_count,followers_count,link,picture,website,verification_status"
        return await self._request("GET", page_id, params={"fields": fields})

    async def get_page_posts(self, limit: int = 25, after: str | None = None) -> dict:
        page_id = await self._get_page_id()
        params: dict = {"fields": "id,message,created_time,type,permalink_url,shares,likes.summary(true),comments.summary(true)", "limit": str(limit)}
        if after:
            params["after"] = after
        return await self._request("GET", f"{page_id}/posts", params=params)

    async def get_post_insights(self, post_id: str) -> dict:
        metrics = "post_impressions,post_engaged_users,post_clicks,post_reactions_by_type_total"
        return await self._request("GET", f"{post_id}/insights", params={"metric": metrics})

    async def publish_post(self, message: str, link: str | None = None) -> dict:
        data: dict = {"message": message}
        if link:
            data["link"] = link
        page_id = await self._get_page_id()
        return await self._request("POST", f"{page_id}/feed", data=data)

    async def get_conversations(self, limit: int = 25) -> dict:
        page_id = await self._get_page_id()
        params = {"fields": "id,participants,updated_time,message_count", "limit": str(limit)}
        return await self._request("GET", f"{page_id}/conversations", params=params)

    async def get_conversation_messages(self, conversation_id: str, limit: int = 25) -> dict:
        params = {"fields": "id,message,from,created_time", "limit": str(limit)}
        return await self._request("GET", f"{conversation_id}/messages", params=params)

    async def send_message(self, recipient_id: str, message: str) -> dict:
        page_id = await self._get_page_id()
        data = {"recipient": {"id": recipient_id}, "message": {"text": message}, "messaging_type": "RESPONSE"}
        return await self._request("POST", f"{page_id}/messages", json=data)

    async def get_post_comments(self, post_id: str, limit: int = 25) -> dict:
        params = {"fields": "id,message,from,created_time,like_count,comment_count", "limit": str(limit)}
        return await self._request("GET", f"{post_id}/comments", params=params)

    async def reply_to_comment(self, comment_id: str, message: str) -> dict:
        return await self._request("POST", f"{comment_id}/comments", data={"message": message})

    async def get_page_insights(self, period: str = "day") -> dict:
        page_id = await self._get_page_id()
        metrics = "page_impressions,page_engaged_users,page_fan_adds,page_views_total"
        return await self._request("GET", f"{page_id}/insights", params={"metric": metrics, "period": period})
