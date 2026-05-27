"""LinkedIn API client using versioned REST API."""
import httpx
import structlog
from .config import get_settings

logger = structlog.get_logger(__name__)

# Use a current LinkedIn API version for /rest/ endpoints
LINKEDIN_API_VERSION = "202504"


class LinkedInAPIError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status


class LinkedInClient:
    """Client for LinkedIn REST API."""

    def __init__(self):
        self.settings = get_settings()
        self.base = self.settings.linkedin_api_base
        self.token: str = self.settings.linkedin_access_token
        self._person_id: str | None = self.settings.linkedin_person_id or None

    def _base_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
        }

    def _rest_headers(self) -> dict:
        """Headers for versioned /rest/ endpoints."""
        h = self._base_headers()
        h["LinkedIn-Version"] = LINKEDIN_API_VERSION
        return h

    async def _request(self, method: str, path: str, *, versioned: bool = False, **kwargs) -> dict:
        url = f"{self.base}/{path}" if not path.startswith("http") else path
        headers = self._rest_headers() if versioned else self._base_headers()
        async with httpx.AsyncClient(timeout=30.0) as c:
            resp = await c.request(method, url, headers=headers, **kwargs)
        if resp.status_code >= 400:
            raise LinkedInAPIError(f"HTTP {resp.status_code}: {resp.text[:500]}", resp.status_code)
        if resp.status_code in (201, 204):
            # For 201 Created, return the Location/id from headers
            location = resp.headers.get("x-restli-id", "")
            return {"status": "success", "id": location}
        return resp.json()

    async def _ensure_person_id(self) -> str:
        """Return cached person ID. Requires LINKEDIN_PERSON_ID env var."""
        if self._person_id:
            return self._person_id
        raise LinkedInAPIError(
            "LINKEDIN_PERSON_ID is not set. "
            "Set this env var to your LinkedIn person URN (e.g. 'FMOmzmrYlA'). "
            "You can find it by reconnecting LinkedIn in the admin panel."
        )

    async def get_profile(self) -> dict:
        return await self._request("GET", "v2/me", params={"projection": "(id,firstName,lastName,profilePicture,headline,vanityName)"})

    async def get_connections_count(self) -> dict:
        return await self._request("GET", "v2/connections", params={"q": "viewer", "count": "0"})

    async def get_posts(self, author_urn: str | None = None, count: int = 20) -> dict:
        urn = author_urn or f"urn:li:person:{await self._ensure_person_id()}"
        return await self._request("GET", "rest/posts", versioned=True, params={"q": "author", "author": urn, "count": str(count)})

    async def create_text_post(self, text: str, visibility: str = "PUBLIC") -> dict:
        person_id = await self._ensure_person_id()
        body = {
            "author": f"urn:li:person:{person_id}",
            "commentary": text,
            "visibility": visibility,
            "distribution": {
                "feedDistribution": "MAIN_FEED",
                "targetEntities": [],
                "thirdPartyDistributionChannels": [],
            },
            "lifecycleState": "PUBLISHED",
        }
        return await self._request("POST", "rest/posts", versioned=True, json=body)

    async def get_post_analytics(self, post_urn: str) -> dict:
        return await self._request("GET", "v2/organizationalEntityShareStatistics", params={"q": "organizationalEntity", "shares": f"List({post_urn})"})

    async def get_company_info(self, org_id: str | None = None) -> dict:
        oid = org_id or self.settings.linkedin_org_id
        if not oid:
            raise LinkedInAPIError("Organization ID required")
        return await self._request("GET", f"v2/organizations/{oid}", params={"projection": "(id,localizedName,vanityName,logoV2,description,staffCountRange)"})

    async def send_message(self, recipient_urn: str, text: str) -> dict:
        body = {
            "recipients": [recipient_urn],
            "subject": "",
            "body": text,
        }
        return await self._request("POST", "v2/messages", json=body)

    async def get_post_comments(self, post_urn: str, count: int = 20) -> dict:
        return await self._request("GET", f"rest/socialActions/{post_urn}/comments", versioned=True, params={"count": str(count)})

    async def reply_to_comment(self, post_urn: str, comment_urn: str, text: str) -> dict:
        person_id = await self._ensure_person_id()
        body = {"actor": f"urn:li:person:{person_id}", "message": {"text": text}}
        return await self._request("POST", f"rest/socialActions/{post_urn}/comments/{comment_urn}/comments", versioned=True, json=body)

    async def get_conversations(self, count: int = 20) -> dict:
        return await self._request("GET", "v2/conversations", params={"count": str(count)})

    async def get_profile_analytics(self, organization_id: str | None = None) -> dict:
        """Get profile/page-level analytics. Organization-level uses follower statistics endpoint;
        member-level falls back to networkSizes for connection counts."""
        oid = organization_id or self.settings.linkedin_org_id
        if oid:
            org_urn = oid if oid.startswith("urn:li:organization:") else f"urn:li:organization:{oid}"
            return await self._request(
                "GET",
                "v2/organizationalEntityFollowerStatistics",
                params={"q": "organizationalEntity", "organizationalEntity": org_urn},
            )
        person_id = await self._ensure_person_id()
        return await self._request(
            "GET",
            f"v2/networkSizes/urn:li:person:{person_id}",
            params={"edgeType": "CompanyFollowedByMember"},
        )
