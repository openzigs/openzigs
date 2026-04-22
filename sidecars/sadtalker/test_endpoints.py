"""Smoke tests for sadtalker sidecar endpoints.

Issue #919 (Epic #883 cleanup) — covers the new ``/gpu-info`` endpoint that
mirrors the audio sidecar so the GPU coordinator (#917) can see the
talking-head pipeline's GPU claim.

Run directly:
    python -m pytest sidecars/sadtalker/test_endpoints.py -v
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))


@pytest.fixture(scope="module")
def client():
    # Stub heavy optional deps before importing server_cuda.
    sys.modules.setdefault("uvicorn", MagicMock())
    import server_cuda  # noqa: E402

    from fastapi.testclient import TestClient

    return TestClient(server_cuda.app)


def test_gpu_info_returns_503_when_torch_missing(client, monkeypatch):
    # Force the in-endpoint import to raise.
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def fake_import(name, *args, **kwargs):
        if name == "torch":
            raise ImportError("torch unavailable in test env")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    res = client.get("/gpu-info")
    assert res.status_code == 503
    assert "detail" in res.json()


def test_gpu_info_returns_503_when_cuda_unavailable(client, monkeypatch):
    fake_torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: False),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    res = client.get("/gpu-info")
    assert res.status_code == 503


def test_gpu_info_returns_payload_when_cuda_available(client, monkeypatch):
    fake_cuda = types.SimpleNamespace(
        is_available=lambda: True,
        current_device=lambda: 0,
        get_device_name=lambda i: "NVIDIA GeForce RTX 3060",
        device_count=lambda: 1,
        mem_get_info=lambda i: (8 * 1024**3, 12 * 1024**3),
    )
    fake_torch = types.SimpleNamespace(cuda=fake_cuda)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1")

    res = client.get("/gpu-info")
    assert res.status_code == 200
    payload = res.json()
    # Field-for-field parity with the audio sidecar's /gpu-info response.
    assert payload["available"] is True
    assert payload["device_index"] == 0
    assert payload["device_name"] == "NVIDIA GeForce RTX 3060"
    assert payload["device_count"] == 1
    assert payload["total_mb"] == 12 * 1024
    assert payload["free_mb"] == 8 * 1024
    assert payload["cuda_visible"] == "1"
