"""Facebook Graph API client."""
import os
from datetime import datetime, timedelta

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

    async def refresh_token_if_needed(self) -> bool:
        """Check token expiry via debug_token and refresh proactively if expiring soon.

        Long-lived page tokens last ~60 days and can only be refreshed while still valid.
        Refreshes if the token expires within 7 days.

        Returns True if the token was refreshed, False if no refresh was needed.
        Raises FacebookAPIError if the token is already expired.
        """
        app_id = self.settings.facebook_app_id
        app_secret = self.settings.facebook_app_secret
        if not app_id or not app_secret:
            logger.warning("Cannot check token expiry: missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET")
            return False

        debug_url = f"{self.settings.meta_graph_api_base}/{self.settings.meta_graph_api_version}/debug_token"
        params = {
            "input_token": self.token,
            "access_token": f"{app_id}|{app_secret}",
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(debug_url, params=params)
            data = resp.json()
        except Exception as e:
            logger.warning("Failed to inspect token via debug_token", error=str(e))
            return False

        token_data = data.get("data", {})
        is_valid = token_data.get("is_valid", False)
        expires_at = token_data.get("expires_at", 0)

        if not is_valid:
            raise FacebookAPIError(
                "Facebook page token is expired or invalid. "
                "Please generate a new long-lived token from the Meta Developer dashboard "
                "(https://developers.facebook.com/tools/explorer/).",
                error_code=190,
                error_subcode=463,
            )

        if expires_at == 0:
            logger.info("Token does not expire")
            return False

        expires_dt = datetime.utcfromtimestamp(expires_at)
        remaining = expires_dt - datetime.utcnow()
        logger.info(
            "Token expiry check",
            expires_at=expires_dt.isoformat(),
            remaining_days=remaining.days,
        )

        if remaining > timedelta(days=7):
            return False

        logger.info("Token expiring soon, attempting refresh", remaining_days=remaining.days)
        exchange_url = (
            f"{self.settings.meta_graph_api_base}/{self.settings.meta_graph_api_version}"
            f"/oauth/access_token"
        )
        exchange_params = {
            "grant_type": "fb_exchange_token",
            "client_id": app_id,
            "client_secret": app_secret,
            "fb_exchange_token": self.token,
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(exchange_url, params=exchange_params)
            result = resp.json()
        except Exception as e:
            logger.error("Token refresh HTTP request failed", error=str(e))
            return False

        if "error" in result:
            err = result["error"]
            logger.error("Token refresh failed", error=err.get("message", "Unknown"))
            return False

        new_token = result.get("access_token")
        if not new_token:
            logger.error("Token refresh response missing access_token")
            return False

        self.token = new_token
        logger.info("Facebook page token refreshed successfully")

        os.environ["FACEBOOK_PAGE_TOKEN"] = new_token
        return True

    async def validate_token(self) -> bool:
        """Validate the page token by making a simple API call."""
        try:
            await self._request("GET", "me", params={"fields": "id"})
            return True
        except FacebookAPIError:
            return False

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
        # Note: 'type', 'shares', 'likes.summary(true)', 'comments.summary(true)' are deprecated in v3.3+
        # Use modern fields only
        params: dict = {"fields": "id,message,created_time,permalink_url", "limit": str(limit)}
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
        # Note: 'like_count', 'comment_count' are deprecated in v3.3+
        params = {"fields": "id,message,from,created_time", "limit": str(limit)}
        return await self._request("GET", f"{post_id}/comments", params=params)

    async def reply_to_comment(self, comment_id: str, message: str) -> dict:
        return await self._request("POST", f"{comment_id}/comments", data={"message": message})

    async def get_page_insights(self, period: str = "day") -> dict:
        page_id = await self._get_page_id()
        metrics = "page_impressions,page_engaged_users,page_fan_adds,page_views_total"
        return await self._request("GET", f"{page_id}/insights", params={"metric": metrics, "period": period})
