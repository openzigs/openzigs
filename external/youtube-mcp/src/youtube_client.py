"""YouTube Data API v3 client."""
import os
from pathlib import Path
from typing import Any, Dict, Optional

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
        # Try resolving by handle first (works with API key, no OAuth needed)
        handle = self.settings.youtube_channel_handle
        if handle:
            # Strip leading @ if present for the forHandle param
            h = handle.lstrip("@")
            data = await self._request("GET", "channels", params={"part": "id", "forHandle": h})
            items = data.get("items", [])
            if items:
                self._channel_id = items[0]["id"]
                return self._channel_id
        # Fall back to OAuth mine=true
        if not self.settings.youtube_oauth_token:
            raise YouTubeAPIError(
                "Cannot determine channel ID. Set YOUTUBE_CHANNEL_ID or YOUTUBE_CHANNEL_HANDLE, "
                "or provide YOUTUBE_OAUTH_TOKEN for auto-detection."
            )
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
        return await self._request("GET", "commentThreads", params={"part": "snippet,replies", "videoId": video_id, "maxResults": str(max_results), "order": "time"})

    async def reply_to_comment(self, parent_id: str, text: str) -> dict:
        return await self._request("POST", "comments", use_oauth=True, params={"part": "snippet"}, json={"snippet": {"parentId": parent_id, "textOriginal": text}})

    async def search_videos(self, query: str, max_results: int = 10, order: str = "relevance") -> dict:
        return await self._request("GET", "search", params={"part": "snippet", "q": query, "maxResults": str(max_results), "type": "video", "order": order})

    async def get_channel_analytics(self) -> dict:
        """Get channel statistics (uses Data API, not Analytics API)."""
        cid = await self._get_channel_id()
        data = await self._request("GET", "channels", params={"part": "statistics", "id": cid})
        items = data.get("items", [])
        return items[0].get("statistics", {}) if items else {}

    # ------------------------------------------------------------------
    # Video upload via resumable upload protocol
    # https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
    # ------------------------------------------------------------------

    _UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3/videos"
    _CHUNK_SIZE = 10 * 1024 * 1024  # 10 MiB per chunk

    async def upload_video(
        self,
        file_path: str,
        title: str,
        description: str = "",
        tags: Optional[list[str]] = None,
        category_id: str = "22",
        privacy_status: str = "private",
        notify_subscribers: bool = True,
    ) -> Dict[str, Any]:
        """Upload a video file to YouTube using the resumable upload protocol.

        Args:
            file_path: Absolute path to the video file on disk.
            title: Video title (max 100 chars).
            description: Video description (max 5000 chars).
            tags: List of keyword tags.
            category_id: YouTube category ID (default "22" = People & Blogs).
            privacy_status: One of "private", "unlisted", "public".
            notify_subscribers: Whether to notify channel subscribers.

        Returns:
            Dict with the uploaded video resource (id, snippet, status, etc.).
        """
        if not self.settings.youtube_oauth_token:
            raise YouTubeAPIError("OAuth token required for video uploads")

        path = Path(file_path)
        if not path.is_file():
            raise YouTubeAPIError(f"Video file not found: {file_path}")

        file_size = path.stat().st_size
        if file_size == 0:
            raise YouTubeAPIError("Video file is empty")

        content_type = self._guess_mime(path)
        metadata = {
            "snippet": {
                "title": title[:100],
                "description": description[:5000],
                "tags": tags or [],
                "categoryId": category_id,
            },
            "status": {
                "privacyStatus": privacy_status,
                "selfDeclaredMadeForKids": False,
            },
        }

        auth_headers = {"Authorization": f"Bearer {self.settings.youtube_oauth_token}"}

        # Step 1 — initiate the resumable upload session
        async with httpx.AsyncClient(timeout=60.0) as c:
            init_resp = await c.post(
                self._UPLOAD_BASE,
                params={
                    "uploadType": "resumable",
                    "part": "snippet,status",
                    "notifySubscribers": str(notify_subscribers).lower(),
                },
                headers={
                    **auth_headers,
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Length": str(file_size),
                    "X-Upload-Content-Type": content_type,
                },
                json=metadata,
            )
            if init_resp.status_code != 200:
                raise YouTubeAPIError(
                    self._parse_api_error(init_resp, "Failed to initiate upload"),
                    init_resp.status_code,
                )
            upload_url = init_resp.headers.get("Location")
            if not upload_url:
                raise YouTubeAPIError("No upload URL returned by YouTube")

        # Step 2 — stream the file in chunks
        logger.info("upload_started", file=str(path), size=file_size, url=upload_url[:80])
        async with httpx.AsyncClient(timeout=300.0) as c:
            with open(path, "rb") as f:
                offset = 0
                while offset < file_size:
                    chunk = f.read(self._CHUNK_SIZE)
                    end = offset + len(chunk) - 1
                    resp = await c.put(
                        upload_url,
                        content=chunk,
                        headers={
                            **auth_headers,
                            "Content-Type": content_type,
                            "Content-Length": str(len(chunk)),
                            "Content-Range": f"bytes {offset}-{end}/{file_size}",
                        },
                    )
                    if resp.status_code == 308:
                        # Incomplete — YouTube wants more chunks
                        offset = end + 1
                        continue
                    if resp.status_code in (200, 201):
                        result = resp.json()
                        logger.info("upload_complete", video_id=result.get("id"))
                        return result
                    raise YouTubeAPIError(
                        self._parse_api_error(resp, f"Upload failed at byte {offset}"),
                        resp.status_code,
                    )

        raise YouTubeAPIError("Upload ended without a completion response")

    @staticmethod
    def _parse_api_error(resp: "httpx.Response", prefix: str) -> str:
        """Extract a clean error message from a YouTube API error response."""
        try:
            body = resp.json()
            error = body.get("error", {})
            reason = ""
            message = error.get("message", "")
            errors_list = error.get("errors", [])
            if errors_list:
                reason = errors_list[0].get("reason", "")
            # Map known reasons to user-friendly messages
            reason_map = {
                "quotaExceeded": "Daily YouTube API quota exceeded. Quota resets at midnight Pacific Time.",
                "rateLimitExceeded": "YouTube API rate limit exceeded. Please wait a moment and try again.",
                "forbidden": "Access denied. Check that your YouTube OAuth token has upload permissions.",
                "insufficientPermissions": "Insufficient permissions. Re-authorize YouTube with upload scope.",
                "unauthorized": "YouTube authorization expired. Please re-connect your YouTube account.",
            }
            if reason in reason_map:
                return reason_map[reason]
            if message:
                import re
                clean = re.sub(r"<[^>]+>", "", message)
                return f"{prefix} (HTTP {resp.status_code}): {clean}"
        except Exception:
            pass
        return f"{prefix} (HTTP {resp.status_code}): {resp.text[:200]}"

    async def check_video_exists(self, video_id: str) -> bool:
        """Check whether a YouTube video still exists (not deleted/private).

        Uses videos.list with part=id — costs only 1 quota unit.
        Returns True if the video is accessible, False otherwise.
        """
        try:
            data = await self._request("GET", "videos", params={"part": "id", "id": video_id})
            items = data.get("items", [])
            return len(items) > 0
        except YouTubeAPIError:
            return False

    _CAPTION_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3/captions"

    async def upload_captions(
        self,
        video_id: str,
        language: str = "en",
        name: str = "English",
        srt_content: str = "",
    ) -> Dict[str, Any]:
        """Upload an SRT caption track to a YouTube video.

        Uses the captions.insert endpoint with multipart upload.
        Costs 400 quota units per call.
        """
        if not self.settings.youtube_oauth_token:
            raise YouTubeAPIError("OAuth token required for caption uploads")
        if not srt_content.strip():
            raise YouTubeAPIError("SRT content is empty")

        import json as _json

        snippet = {
            "snippet": {
                "videoId": video_id,
                "language": language,
                "name": name[:150],
                "isDraft": False,
            }
        }

        boundary = "caption_boundary_openzigs"
        body_parts = [
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{_json.dumps(snippet)}\r\n",
            f"--{boundary}\r\n"
            f"Content-Type: application/x-subrip\r\n\r\n"
            f"{srt_content}\r\n",
            f"--{boundary}--\r\n",
        ]
        body = "".join(body_parts)

        auth_headers = {
            "Authorization": f"Bearer {self.settings.youtube_oauth_token}",
            "Content-Type": f"multipart/related; boundary={boundary}",
        }

        async with httpx.AsyncClient(timeout=60.0) as c:
            resp = await c.post(
                self._CAPTION_UPLOAD_BASE,
                params={"uploadType": "multipart", "part": "snippet"},
                headers=auth_headers,
                content=body.encode("utf-8"),
            )
        if resp.status_code >= 400:
            raise YouTubeAPIError(
                self._parse_api_error(resp, "Caption upload failed"),
                resp.status_code,
            )
        return resp.json()

    @staticmethod
    def _guess_mime(path: Path) -> str:
        ext = path.suffix.lower()
        mime_map = {
            ".mp4": "video/mp4",
            ".avi": "video/x-msvideo",
            ".mov": "video/quicktime",
            ".wmv": "video/x-ms-wmv",
            ".flv": "video/x-flv",
            ".webm": "video/webm",
            ".mkv": "video/x-matroska",
            ".3gp": "video/3gpp",
            ".mpg": "video/mpeg",
            ".mpeg": "video/mpeg",
        }
        return mime_map.get(ext, "application/octet-stream")
