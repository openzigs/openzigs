"""Twitter/X API v2 client."""
import hashlib
import hmac
import time
import base64
import secrets
from urllib.parse import quote

import httpx
import structlog
from .config import get_settings

logger = structlog.get_logger(__name__)


class TwitterAPIError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status


class TwitterClient:
    """Client for Twitter API v2."""

    def __init__(self):
        self.settings = get_settings()
        self.base = self.settings.twitter_api_base
        self.bearer = self.settings.twitter_bearer_token

    def _bearer_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.bearer}", "Content-Type": "application/json"}

    def _oauth1_headers(self, method: str, url: str, params: dict | None = None) -> dict:
        """Generate OAuth 1.0a headers for user-context endpoints (tweet, DM)."""
        s = self.settings
        if not s.twitter_api_key or not s.twitter_access_token:
            raise TwitterAPIError("OAuth 1.0a credentials required for write operations")

        oauth_params = {
            "oauth_consumer_key": s.twitter_api_key,
            "oauth_nonce": secrets.token_hex(16),
            "oauth_signature_method": "HMAC-SHA1",
            "oauth_timestamp": str(int(time.time())),
            "oauth_token": s.twitter_access_token,
            "oauth_version": "1.0",
        }
        all_params = {**oauth_params, **(params or {})}
        sorted_params = "&".join(f"{quote(k, safe='')}={quote(str(v), safe='')}" for k, v in sorted(all_params.items()))
        base_string = f"{method.upper()}&{quote(url, safe='')}&{quote(sorted_params, safe='')}"
        signing_key = f"{quote(s.twitter_api_secret, safe='')}&{quote(s.twitter_access_token_secret, safe='')}"
        sig = base64.b64encode(hmac.new(signing_key.encode(), base_string.encode(), hashlib.sha1).digest()).decode()
        oauth_params["oauth_signature"] = sig
        auth_header = "OAuth " + ", ".join(f'{quote(k, safe="")}="{quote(v, safe="")}"' for k, v in sorted(oauth_params.items()))
        return {"Authorization": auth_header, "Content-Type": "application/json"}

    async def _request(self, method: str, path: str, *, auth: str = "bearer", **kwargs) -> dict:
        url = f"{self.base}/{path}" if not path.startswith("http") else path
        headers = self._bearer_headers() if auth == "bearer" else self._oauth1_headers(method, url)
        async with httpx.AsyncClient(timeout=30.0) as c:
            resp = await c.request(method, url, headers=headers, **kwargs)
        if resp.status_code >= 400:
            text = resp.text[:500]
            raise TwitterAPIError(f"HTTP {resp.status_code}: {text}", resp.status_code)
        return resp.json()

    async def get_me(self) -> dict:
        return await self._request("GET", "users/me", params={"user.fields": "id,name,username,description,public_metrics,profile_image_url,verified"})

    async def get_user_tweets(self, user_id: str, max_results: int = 10) -> dict:
        return await self._request("GET", f"users/{user_id}/tweets", params={"max_results": str(max_results), "tweet.fields": "created_at,public_metrics,text,source"})

    async def search_tweets(self, query: str, max_results: int = 10) -> dict:
        return await self._request("GET", "tweets/search/recent", params={"query": query, "max_results": str(max_results), "tweet.fields": "created_at,public_metrics,author_id,text"})

    async def get_tweet(self, tweet_id: str) -> dict:
        return await self._request("GET", f"tweets/{tweet_id}", params={"tweet.fields": "created_at,public_metrics,text,author_id,conversation_id"})

    async def post_tweet(self, text: str, reply_to: str | None = None) -> dict:
        body: dict = {"text": text}
        if reply_to:
            body["reply"] = {"in_reply_to_tweet_id": reply_to}
        return await self._request("POST", "tweets", auth="oauth1", json=body)

    async def get_dm_events(self, max_results: int = 20) -> dict:
        return await self._request("GET", "dm_events", params={"max_results": str(max_results), "dm_event.fields": "id,text,created_at,sender_id,dm_conversation_id"})

    async def send_dm(self, participant_id: str, text: str) -> dict:
        return await self._request("POST", "dm_conversations", auth="oauth1", json={"message": {"text": text}, "participant_ids": [participant_id], "conversation_type": "Group"})

    async def get_user_by_username(self, username: str) -> dict:
        return await self._request("GET", f"users/by/username/{username}", params={"user.fields": "id,name,username,description,public_metrics"})
