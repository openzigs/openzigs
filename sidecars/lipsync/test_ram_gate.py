"""Issue #1106 — RAM-gating for LatentSync v1.6 on the lipsync sidecar.

Run directly:
    python -m pytest sidecars/lipsync/test_ram_gate.py -v
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest

_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))


def _reload_server(monkeypatch, *, force_ram_gb: str | None) -> "module":  # type: ignore[name-defined]
    """Reload server.py with OPENZIGS_FORCE_RAM_GB pinned for this test."""
    if force_ram_gb is None:
        monkeypatch.delenv("OPENZIGS_FORCE_RAM_GB", raising=False)
    else:
        monkeypatch.setenv("OPENZIGS_FORCE_RAM_GB", force_ram_gb)
    # Skip auth in tests
    monkeypatch.delenv("LIPSYNC_SECRET_TOKEN", raising=False)
    if "server" in sys.modules:
        del sys.modules["server"]
    return importlib.import_module("server")


def _payload(model_version: str) -> dict:
    return {
        "job_id": "00000000-0000-0000-0000-000000000001",
        "callback_url": "http://callback.local/done",
        "progress_url": "http://callback.local/progress",
        "video_data": "dmlkZW8=",
        "audio_data": "YXVkaW8=",
        "inference_steps": 20,
        "guidance_scale": 1.5,
        "enable_deepcache": True,
        "model_version": model_version,
    }


def test_v16_returns_507_when_host_ram_below_threshold(monkeypatch):
    server = _reload_server(monkeypatch, force_ram_gb="16")
    from fastapi.testclient import TestClient

    client = TestClient(server.app)
    res = client.post("/generate", json=_payload("v1.6"))
    assert res.status_code == 507, res.text
    body = res.json()
    assert body["error"] == "insufficient_unified_memory"
    assert body["host_ram_gb"] == 16.0
    assert body["required_gb"] == 24.0
    assert "v1.5" in body["message"]


def test_v15_accepted_on_low_ram_host(monkeypatch):
    server = _reload_server(monkeypatch, force_ram_gb="16")
    # Avoid kicking off the actual pipeline task
    monkeypatch.setattr(server.asyncio, "create_task", lambda coro: coro.close() or None)
    from fastapi.testclient import TestClient

    client = TestClient(server.app)
    res = client.post("/generate", json=_payload("v1.5"))
    assert res.status_code == 202, res.text
    assert res.json()["status"] == "accepted"


def test_v16_accepted_on_32gb_host(monkeypatch):
    server = _reload_server(monkeypatch, force_ram_gb="32")
    monkeypatch.setattr(server.asyncio, "create_task", lambda coro: coro.close() or None)
    from fastapi.testclient import TestClient

    client = TestClient(server.app)
    res = client.post("/generate", json=_payload("v1.6"))
    assert res.status_code == 202, res.text
    assert res.json()["status"] == "accepted"
