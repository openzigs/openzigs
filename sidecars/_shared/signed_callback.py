"""
Shared HMAC + timestamp signing helper for OpenZigs sidecar callbacks.

Issue #1089 — sign every POST to /api/queue/complete and /api/queue/progress
so the central server can verify authenticity even when the sidecar is
exposed via a Cloudflare tunnel.

Also adds the X-OpenZigs-Node-Type header used by issue #1087's per-node-
type rate limiter.

Sign format:
    X-OpenZigs-Timestamp: <unix-seconds>
    X-OpenZigs-Signature: sha256=<hex>
    X-OpenZigs-Node-Type: <node-name>

The signature is HMAC_SHA256(secret, b"{ts}." + body_bytes).hexdigest().

CRITICAL: callers MUST pass the *exact* body bytes to httpx via `data=`
or to urllib via `Request(data=...)`. Re-serializing the dict will break
HMAC because dict→JSON ordering is not always stable.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional, Tuple


def serialize_body(payload: Any) -> bytes:
    """Canonical JSON serialization for callbacks.

    Use this for both signing and sending so the bytes match exactly.
    """
    return json.dumps(payload, separators=(",", ":"), sort_keys=False).encode(
        "utf-8"
    )


def signed_headers(
    secret: Optional[str],
    body: bytes,
    node_type: str,
    *,
    timestamp: Optional[int] = None,
    legacy_bearer: bool = False,
) -> Dict[str, str]:
    """Return the header dict for a signed callback POST.

    Always sets Content-Type and X-OpenZigs-Node-Type. When `secret` is
    truthy, sets X-OpenZigs-Timestamp + X-OpenZigs-Signature. When
    `legacy_bearer=True`, also sets Authorization: Bearer <secret> for
    one-release backwards compatibility with the v1 server.
    """
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "X-OpenZigs-Node-Type": node_type,
    }
    if not secret:
        return headers

    ts = str(int(timestamp if timestamp is not None else time.time()))
    mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
    mac.update((ts + ".").encode("utf-8"))
    mac.update(body)
    headers["X-OpenZigs-Timestamp"] = ts
    headers["X-OpenZigs-Signature"] = "sha256=" + mac.hexdigest()
    if legacy_bearer:
        headers["Authorization"] = f"Bearer {secret}"
    return headers


def prepare_signed_post(
    payload: Any,
    secret: Optional[str],
    node_type: str,
    *,
    timestamp: Optional[int] = None,
    legacy_bearer: bool = False,
) -> Tuple[bytes, Dict[str, str]]:
    """Convenience: serialize + sign in one call.

    Returns (body_bytes, headers). Pass body_bytes to your HTTP client's
    raw data= parameter — do NOT pass payload as json= or you'll
    re-serialize and the signature will mismatch.
    """
    body = serialize_body(payload)
    return body, signed_headers(
        secret,
        body,
        node_type,
        timestamp=timestamp,
        legacy_bearer=legacy_bearer,
    )
