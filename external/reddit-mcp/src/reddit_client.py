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

    async def get_post_analytics(self, post_id: str) -> dict:
        """Get analytics for a post: score, upvote ratio, comment count, awards.
        Accepts either a bare ID or a t3_xxx fullname."""
        bare = post_id[3:] if post_id.startswith("t3_") else post_id
        data = await self._request("GET", "api/info", params={"id": f"t3_{bare}"})
        children = data.get("data", {}).get("children", []) if isinstance(data, dict) else []
        if not children:
            return {"post_id": bare, "found": False}
        post = children[0].get("data", {})
        return {
            "post_id": bare,
            "found": True,
            "subreddit": post.get("subreddit"),
            "title": post.get("title"),
            "score": post.get("score"),
            "upvote_ratio": post.get("upvote_ratio"),
            "num_comments": post.get("num_comments"),
            "total_awards_received": post.get("total_awards_received", 0),
            "created_utc": post.get("created_utc"),
            "permalink": post.get("permalink"),
            "url": post.get("url"),
        }

    async def get_subreddit_health(self, subreddit: str) -> dict:
        """Get health metrics for a subreddit: subscribers, active users,
        post velocity (per day from recent new posts), and avg score of recent top posts."""
        about = await self._request("GET", f"r/{subreddit}/about")
        about_data = about.get("data", {}) if isinstance(about, dict) else {}
        new_posts = await self._request("GET", f"r/{subreddit}/new", params={"limit": "25"})
        children = new_posts.get("data", {}).get("children", []) if isinstance(new_posts, dict) else []
        timestamps = [c.get("data", {}).get("created_utc") for c in children if c.get("data", {}).get("created_utc")]
        velocity_per_day = None
        if len(timestamps) >= 2:
            span_seconds = max(timestamps) - min(timestamps)
            if span_seconds > 0:
                velocity_per_day = round(len(timestamps) * 86400 / span_seconds, 2)
        top_posts = await self._request("GET", f"r/{subreddit}/top", params={"limit": "10", "t": "week"})
        top_children = top_posts.get("data", {}).get("children", []) if isinstance(top_posts, dict) else []
        scores = [c.get("data", {}).get("score", 0) for c in top_children]
        avg_top_score = round(sum(scores) / len(scores), 1) if scores else None
        return {
            "subreddit": subreddit,
            "subscribers": about_data.get("subscribers"),
            "active_user_count": about_data.get("active_user_count"),
            "public_description": about_data.get("public_description"),
            "created_utc": about_data.get("created_utc"),
            "post_velocity_per_day": velocity_per_day,
            "avg_top_score_week": avg_top_score,
            "sample_recent_posts": len(timestamps),
        }
