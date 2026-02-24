"""Reddit API client (OAuth2 script-type)."""
import httpx
import structlog
from .config import get_settings

logger = structlog.get_logger(__name__)


class RedditAPIError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status


class RedditClient:
    """Client for Reddit OAuth2 API."""

    def __init__(self):
        self.settings = get_settings()
        self.base = self.settings.reddit_api_base
        self._token: str | None = None

    async def _ensure_token(self) -> str:
        if self._token:
            return self._token
        s = self.settings
        async with httpx.AsyncClient(timeout=15.0) as c:
            resp = await c.post(
                "https://www.reddit.com/api/v1/access_token",
                auth=(s.reddit_client_id, s.reddit_client_secret),
                data={"grant_type": "password", "username": s.reddit_username, "password": s.reddit_password},
                headers={"User-Agent": s.reddit_user_agent},
            )
        if resp.status_code != 200:
            raise RedditAPIError(f"Auth failed: {resp.text[:300]}", resp.status_code)
        data = resp.json()
        self._token = data["access_token"]
        return self._token

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        token = await self._ensure_token()
        url = f"{self.base}/{path}" if not path.startswith("http") else path
        headers = {"Authorization": f"bearer {token}", "User-Agent": self.settings.reddit_user_agent}
        async with httpx.AsyncClient(timeout=30.0) as c:
            resp = await c.request(method, url, headers=headers, **kwargs)
        if resp.status_code == 401:
            self._token = None
            token = await self._ensure_token()
            headers["Authorization"] = f"bearer {token}"
            async with httpx.AsyncClient(timeout=30.0) as c:
                resp = await c.request(method, url, headers=headers, **kwargs)
        if resp.status_code >= 400:
            raise RedditAPIError(f"HTTP {resp.status_code}: {resp.text[:500]}", resp.status_code)
        return resp.json()

    async def get_me(self) -> dict:
        return await self._request("GET", "api/v1/me")

    async def get_subreddit_posts(self, subreddit: str, sort: str = "hot", limit: int = 25) -> dict:
        return await self._request("GET", f"r/{subreddit}/{sort}", params={"limit": str(limit)})

    async def get_post_comments(self, subreddit: str, post_id: str, limit: int = 25) -> list:
        return await self._request("GET", f"r/{subreddit}/comments/{post_id}", params={"limit": str(limit)})

    async def submit_post(self, subreddit: str, title: str, text: str | None = None, url: str | None = None) -> dict:
        data: dict = {"sr": subreddit, "title": title, "kind": "link" if url else "self"}
        if text:
            data["text"] = text
        if url:
            data["url"] = url
        return await self._request("POST", "api/submit", data=data)

    async def reply_to_comment(self, thing_id: str, text: str) -> dict:
        return await self._request("POST", "api/comment", data={"thing_id": thing_id, "text": text})

    async def search(self, query: str, subreddit: str | None = None, limit: int = 25) -> dict:
        path = f"r/{subreddit}/search" if subreddit else "search"
        params: dict = {"q": query, "limit": str(limit), "sort": "relevance", "type": "link"}
        if subreddit:
            params["restrict_sr"] = "true"
        return await self._request("GET", path, params=params)

    async def get_inbox(self, limit: int = 25) -> dict:
        return await self._request("GET", "message/inbox", params={"limit": str(limit)})

    async def send_message(self, recipient: str, subject: str, text: str) -> dict:
        return await self._request("POST", "api/compose", data={"to": recipient, "subject": subject, "text": text})
