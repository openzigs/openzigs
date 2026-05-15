"""Shared SSRF guard for OpenZigs sidecar callback URLs."""

from __future__ import annotations

import ipaddress
import os
from typing import Iterable
from urllib.parse import urlparse


TRUSTED_CALLBACK_HOSTS_ENV = "OPENZIGS_TRUSTED_CALLBACK_HOSTS"
_TRUSTED_CALLBACK_URL_ENVS = (
    "OPENZIGS_CALLBACK_URL",
    "QUEUE_CALLBACK_URL",
    "OPENZIGS_PROGRESS_URL",
    "QUEUE_PROGRESS_URL",
)


def _normalize_host(host: str) -> str:
    """Normalize a hostname for exact allowlist comparison."""
    return host.strip().strip("[]").rstrip(".").lower()


def _host_from_entry(entry: str) -> str | None:
    """Extract a host from either a URL or a host[:port] allowlist entry."""
    candidate = entry.strip()
    if not candidate:
        return None
    parsed = urlparse(candidate if "://" in candidate else f"//{candidate}")
    return _normalize_host(parsed.hostname or "") or None


def trusted_callback_hosts() -> set[str]:
    """Return server-controlled public callback hosts trusted by this worker.

    The allowlist is intentionally sourced only from worker environment
    configuration, never from the request body. Entries may be bare hosts,
    host:port values, or full URLs.
    """
    hosts: set[str] = set()
    raw_hosts = os.getenv(TRUSTED_CALLBACK_HOSTS_ENV, "")
    for entry in raw_hosts.split(","):
        host = _host_from_entry(entry)
        if host:
            hosts.add(host)

    for env_name in _TRUSTED_CALLBACK_URL_ENVS:
        host = _host_from_entry(os.getenv(env_name, ""))
        if host:
            hosts.add(host)
    return hosts


def is_safe_callback_host(
    host: str,
    trusted_hosts: Iterable[str] | None = None,
) -> bool:
    """Return True when *host* is a local target or an exact trusted host."""
    normalized = _normalize_host(host)
    if not normalized:
        return False
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        addr = ipaddress.ip_address(normalized)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        pass
    if normalized.endswith(".local"):
        return True
    configured_hosts = trusted_callback_hosts() if trusted_hosts is None else trusted_hosts
    allowed = {_normalize_host(h) for h in configured_hosts}
    return normalized in allowed


def is_safe_callback_url(url: str) -> bool:
    """Return True when *url* is http(s) and targets an allowed callback host."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        return is_safe_callback_host(parsed.hostname or "")
    except Exception:
        return False


def validate_callback_url(url: str) -> str:
    """Return *url* when safe, otherwise raise ValueError."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"URL scheme must be http or https, got: {parsed.scheme}")
    hostname = _normalize_host(parsed.hostname or "")
    if not hostname:
        raise ValueError("URL must have a hostname")
    if not is_safe_callback_host(hostname):
        raise ValueError(
            f"Blocked callback host {hostname!r}: host must be private / "
            "loopback / .local / link-local or configured in "
            f"{TRUSTED_CALLBACK_HOSTS_ENV} / OPENZIGS_CALLBACK_URL"
        )
    return url