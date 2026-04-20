"""Path-traversal regression tests for the image-gen sidecar's safe_join.

Sub-issue #907: Pin the contract of ``safe_join`` so a future regression
(for example removing the ``startswith(base + os.sep)`` check or skipping
``os.path.realpath``) flips a named test instead of silently re-introducing
a path-traversal sink.

Run directly:
    python -m pytest sidecars/image-gen/test_safe_join.py -v

Or together with the rest of the sidecar tests:
    python -m pytest sidecars/image-gen/
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# Add the sidecar directory to sys.path so the bare ``path_utils`` import in
# the production servers (``from path_utils import safe_join``) and our test
# import below both resolve correctly without requiring an installed package.
_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

from path_utils import safe_join, sanitize_path  # noqa: E402


@pytest.fixture
def base_dir(tmp_path: Path) -> str:
    """A scratch base directory the helper must contain inputs to."""
    base = tmp_path / "openzigs-base"
    base.mkdir()
    return str(base)


# ── safe_join ────────────────────────────────────────────────────────────


def test_safe_join_accepts_simple_relative_file(base_dir: str) -> None:
    """Happy path: a plain filename resolves under the base."""
    out = safe_join(base_dir, "image.png")
    assert out.startswith(os.path.realpath(base_dir) + os.sep)
    assert out.endswith(os.sep + "image.png")


def test_safe_join_accepts_nested_relative_file(base_dir: str) -> None:
    out = safe_join(base_dir, os.path.join("sub", "image.png"))
    assert out.startswith(os.path.realpath(base_dir) + os.sep)


def test_safe_join_rejects_parent_directory_traversal(base_dir: str) -> None:
    with pytest.raises(ValueError, match="Path traversal blocked"):
        safe_join(base_dir, "../../etc/passwd")


def test_safe_join_rejects_repeated_dot_dot(base_dir: str) -> None:
    with pytest.raises(ValueError, match="Path traversal blocked"):
        safe_join(base_dir, "../../../../../../../../etc/passwd")


def test_safe_join_rejects_absolute_posix_path(base_dir: str) -> None:
    # On POSIX, os.path.join discards `base` when the second arg is absolute.
    # The realpath result is /etc/passwd, which is outside base, so the
    # startswith check must reject it.  On Windows, /etc/passwd resolves
    # under the current drive root, also outside base.
    with pytest.raises(ValueError, match="Path traversal blocked"):
        safe_join(base_dir, "/etc/passwd")


def test_safe_join_rejects_windows_drive_letter(base_dir: str) -> None:
    # Even on POSIX, a string like "C:\\Windows\\System32" is treated as a
    # weird relative segment.  os.path.realpath then produces something like
    # ``<cwd>/<base>/C:\\Windows\\System32`` which still lives under base —
    # so we explicitly check the helper handles this without escaping.  On
    # Windows, ``C:\\Windows\\...`` is absolute and lands outside base,
    # which the helper must reject.
    user_path = "C:\\Windows\\System32\\drivers\\etc\\hosts"
    if os.name == "nt":
        with pytest.raises(ValueError, match="Path traversal blocked"):
            safe_join(base_dir, user_path)
    else:
        # POSIX: result must still be contained inside base.
        out = safe_join(base_dir, user_path)
        assert out.startswith(os.path.realpath(base_dir) + os.sep)


def test_safe_join_rejects_null_byte(base_dir: str) -> None:
    with pytest.raises(ValueError, match="null bytes"):
        safe_join(base_dir, "image\x00.png")


def test_safe_join_rejects_non_string_input(base_dir: str) -> None:
    with pytest.raises(ValueError):
        safe_join(base_dir, 12345)  # type: ignore[arg-type]


def test_safe_join_rejects_symlink_escape(base_dir: str) -> None:
    """A symlink planted *inside* base that points outside must be rejected.

    This is the symlink-escape vector called out in the PR review for #907.
    Without the ``os.path.realpath`` symlink resolution + ``startswith``
    check, the helper would happily return a path that, when opened, reads
    files outside the base directory.
    """
    outside = tempfile.mkdtemp(prefix="safe-join-outside-")
    link_path = os.path.join(base_dir, "evil-link")
    try:
        try:
            os.symlink(outside, link_path, target_is_directory=True)
        except (OSError, NotImplementedError) as err:
            # Windows without Developer Mode / admin privileges can't create
            # symlinks.  Skip rather than fail — the helper itself is what's
            # under test, not the OS's symlink permissions.
            pytest.skip(f"symlink unsupported in this environment: {err}")

        with pytest.raises(ValueError, match="Path traversal blocked"):
            safe_join(base_dir, "evil-link")
        # Also via a deeper path: link/<file>
        with pytest.raises(ValueError, match="Path traversal blocked"):
            safe_join(base_dir, os.path.join("evil-link", "secret.txt"))
    finally:
        if os.path.islink(link_path):
            os.unlink(link_path)
        try:
            os.rmdir(outside)
        except OSError:
            pass


# ── sanitize_path (legacy companion) ─────────────────────────────────────


def test_sanitize_path_rejects_null_byte() -> None:
    with pytest.raises(ValueError, match="null bytes"):
        sanitize_path("foo\x00.png")


def test_sanitize_path_rejects_dot_dot_segment() -> None:
    with pytest.raises(ValueError, match="Path traversal"):
        sanitize_path(os.path.join("..", "etc", "passwd"))


def test_sanitize_path_passes_normal_filename() -> None:
    assert sanitize_path("image.png") == "image.png"
