"""LinkedIn API v2 client."""
import httpx
import structlog
from .config import get_settings

logger = structlog.get_logger(__name__)


class LinkedInAPIError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status


class LinkedInClient:
    """Client for LinkedIn API v2."""

    def __init__(self):
        self.settings = get_settings()
        self.base = self.settings.linkedin_api_base
        self.token = self.settings.linkedin_access_token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
            "LinkedIn-Version": "202402",
        }

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        url = f"{self.base}/{path}" if not path.startswith("http") else path
        async with httpx.AsyncClient(timeout=30.0) as c:
            resp = await c.request(method, url, headers=self._headers(), **kwargs)
        if resp.status_code >= 400:
            raise LinkedInAPIError(f"HTTP {resp.status_code}: {resp.text[:500]}", resp.status_code)
        if resp.status_code == 204:
            return {"status": "success"}
        return resp.json()

    async def get_profile(self) -> dict:
        return await self._request("GET", "me", params={"projection": "(id,firstName,lastName,profilePicture,headline,vanityName)"})

    async def get_connections_count(self) -> dict:
        return await self._request("GET", "connections", params={"q": "viewer", "count": "0"})

    async def get_posts(self, author_urn: str | None = None, count: int = 20) -> dict:
        urn = author_urn or f"urn:li:person:{self.settings.linkedin_person_id}"
        return await self._request("GET", "ugcPosts", params={"q": "authors", "authors": f"List({urn})", "count": str(count)})

    async def create_text_post(self, text: str, visibility: str = "PUBLIC") -> dict:
        person_id = self.settings.linkedin_person_id
        body = {
            "author": f"urn:li:person:{person_id}",
            "lifecycleState": "PUBLISHED",
            "specificContent": {
                "com.linkedin.ugc.ShareContent": {
                    "shareCommentary": {"text": text},
                    "shareMediaCategory": "NONE",
                }
            },
            "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": visibility},
        }
        return await self._request("POST", "ugcPosts", json=body)

    async def get_post_analytics(self, post_urn: str) -> dict:
        return await self._request("GET", "organizationalEntityShareStatistics", params={"q": "organizationalEntity", "shares": f"List({post_urn})"})

    async def get_company_info(self, org_id: str | None = None) -> dict:
        oid = org_id or self.settings.linkedin_org_id
        if not oid:
            raise LinkedInAPIError("Organization ID required")
        return await self._request("GET", f"organizations/{oid}", params={"projection": "(id,localizedName,vanityName,logoV2,description,staffCountRange)"})

    async def send_message(self, recipient_urn: str, text: str) -> dict:
        body = {
            "recipients": [recipient_urn],
            "subject": "",
            "body": text,
        }
        return await self._request("POST", "messages", json=body)

    async def get_post_comments(self, post_urn: str, count: int = 20) -> dict:
        return await self._request("GET", f"socialActions/{post_urn}/comments", params={"count": str(count)})

    async def reply_to_comment(self, post_urn: str, comment_urn: str, text: str) -> dict:
        body = {"actor": f"urn:li:person:{self.settings.linkedin_person_id}", "message": {"text": text}}
        return await self._request("POST", f"socialActions/{post_urn}/comments/{comment_urn}/comments", json=body)

    async def get_conversations(self, count: int = 20) -> dict:
        return await self._request("GET", "conversations", params={"count": str(count)})
