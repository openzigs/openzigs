"""Tests for the v2a /generate endpoint contract.

Issue #939 gap D: when MMAudio isn't importable, /generate must return
HTTP 503 with an actionable error message. When it IS importable, valid
inputs must be accepted (202) and invalid inputs rejected with HTTP 4xx
synchronously — never accept-then-silently-fail.

These tests fully mock the mmaudio loader and override the FastAPI
``_probe_mmaudio`` call inside the app's lifespan, so they run on any
host (CI, dev laptops without GPUs).
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


@pytest.fixture
def server():
    """Re-import the server module fresh for each test."""
    sys.modules.pop("server_cuda", None)
    import server_cuda as sc  # type: ignore
    yield sc
    sys.modules.pop("server_cuda", None)


def _client_with_mmaudio(server, *, available, error):
    """Return (TestClient, probe-patch context).

    The app's `_lifespan` runs `_probe_mmaudio()` on enter, which would
    overwrite any values we set before opening the client. Patching the
    probe at the module level forces lifespan to seed the desired state.
    """
    return TestClient(server.app), patch.object(
        server, "_probe_mmaudio", return_value=(available, error)
    )


def test_generate_returns_503_when_mmaudio_unavailable(server):
    """Gap D: missing mmaudio package → 503 with actionable error message."""
    client, probe_patch = _client_with_mmaudio(
        server, available=False,
        error="ModuleNotFoundError: No module named 'mmaudio'",
    )
    with probe_patch, client:
        resp = client.post(
            "/generate",
            json={
                "job_id": "test-job-1",
                "video_b64": "dGVzdA==",
                "duration_sec": 3.0,
            },
        )
    assert resp.status_code == 503
    detail = resp.json().get("detail", "")
    assert "MMAudio not installed" in detail
    assert "pip install" in detail
    assert "ModuleNotFoundError" in detail


def test_generate_returns_400_for_invalid_job_id(server):
    """Bad job_id is rejected by safe_job_id() with HTTP 400."""
    client, probe_patch = _client_with_mmaudio(server, available=True, error=None)
    with probe_patch, client:
        resp = client.post(
            "/generate",
            json={
                "job_id": "../etc/passwd",
                "video_b64": "dGVzdA==",
                "duration_sec": 3.0,
            },
        )
    assert resp.status_code == 400
    assert "job_id must match" in resp.json().get("detail", "")


def test_generate_returns_400_when_no_video_input(server):
    """Both video_path and video_b64 missing → 400 synchronous reject."""
    client, probe_patch = _client_with_mmaudio(server, available=True, error=None)
    with probe_patch, client:
        resp = client.post(
            "/generate",
            json={
                "job_id": "test-job-2",
                "duration_sec": 3.0,
            },
        )
    assert resp.status_code == 400
    detail = resp.json().get("detail", "")
    assert "video_path" in detail or "video_b64" in detail


def test_generate_accepts_valid_request_when_mmaudio_available(server):
    """Happy path: valid request with mmaudio available → 202 accepted."""
    async def _stub_run_job(_request):
        return None

    client, probe_patch = _client_with_mmaudio(server, available=True, error=None)
    with probe_patch, patch.object(server, "_run_job", _stub_run_job), client:
        resp = client.post(
            "/generate",
            json={
                "job_id": "test-job-3",
                "video_b64": "dGVzdA==",
                "duration_sec": 3.0,
            },
        )
    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "accepted"
    assert body["job_id"] == "test-job-3"


def test_health_surfaces_mmaudio_status(server):
    client, probe_patch = _client_with_mmaudio(
        server, available=False, error="ImportError: simulated",
    )
    with probe_patch, client:
        resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["sidecar"] == "v2a"
    assert body["mmaudio_available"] is False
    assert body["mmaudio_import_error"] == "ImportError: simulated"
    assert "variant" in body


def test_health_when_mmaudio_present(server):
    client, probe_patch = _client_with_mmaudio(server, available=True, error=None)
    with probe_patch, client:
        resp = client.get("/health")
    body = resp.json()
    assert body["mmaudio_available"] is True
    assert body["mmaudio_import_error"] is None


def test_load_pipeline_raises_when_mmaudio_missing(server):
    """The loader must raise RuntimeError, not silently return None,
    so /generate's caller can persist audio_status=failed."""
    server._MMAUDIO_AVAILABLE = False
    server._MMAUDIO_IMPORT_ERROR = "ModuleNotFoundError: simulated"
    server._pipeline = None
    with pytest.raises(RuntimeError) as exc_info:
        server._load_pipeline()
    msg = str(exc_info.value)
    assert "MMAudio is not installed" in msg
    assert "pip install" in msg
    assert "ModuleNotFoundError" in msg


def test_probe_mmaudio_returns_tuple(server):
    """The probe must return a (bool, str|None) tuple in either case."""
    available, err = server._probe_mmaudio()
    assert isinstance(available, bool)
    if available:
        assert err is None
    else:
        assert isinstance(err, str) and len(err) > 0


def test_safe_job_id_rejects_path_traversal(server):
    """Defense in depth: job_ids that would escape filename context fail."""
    with pytest.raises(ValueError):
        server.safe_job_id("../etc/passwd")
    with pytest.raises(ValueError):
        server.safe_job_id("foo/bar")
    with pytest.raises(ValueError):
        server.safe_job_id("")
    assert server.safe_job_id("good-id_123") == "good-id_123"
    assert server.safe_job_id("a" * 128) == "a" * 128
