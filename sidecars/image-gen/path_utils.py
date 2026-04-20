"""Shared filesystem-safety helpers for the image-gen sidecar.

Sub-issue #907: Extracted into a standalone module so the regression test
suite (``test_safe_join.py``) exercises the exact helper used by
``server.py`` / ``server_cuda.py`` without pulling in their heavy ML
dependencies (torch, diffusers, fastapi).
"""

from __future__ import annotations

import os


def safe_join(base_dir: str, user_path: str) -> str:
    """Safely join ``base_dir`` with an untrusted ``user_path`` component.

    Resolves symbolic links via ``os.path.realpath`` and ensures the result
    stays under ``base_dir``.  Raises ``ValueError`` on path-traversal
    attempts (``..`` segments, absolute paths that escape, drive letters on
    Windows, symlinks pointing outside the base directory).
    """
    if not isinstance(user_path, str):
        raise ValueError("user_path must be a string")
    if "\x00" in user_path:
        raise ValueError("Path contains null bytes")
    base = os.path.realpath(base_dir)
    joined = os.path.realpath(os.path.join(base, user_path))
    if not joined.startswith(base + os.sep) and joined != base:
        raise ValueError(f"Path traversal blocked: {user_path}")
    return joined


def sanitize_path(user_path: str) -> str:
    """Validate a user-supplied file path for basic safety.

    Rejects null bytes and path-traversal sequences.  Use ``safe_join`` when
    the path must reside under a specific base directory.
    """
    if not isinstance(user_path, str):
        raise ValueError("user_path must be a string")
    s = str(user_path)
    if "\x00" in s:
        raise ValueError("Path contains null bytes")
    normed = os.path.normpath(s)
    if ".." in normed.split(os.sep):
        raise ValueError(f"Path traversal detected: {user_path}")
    return normed
