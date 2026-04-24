"""Issue #939 — `/capabilities` flat-schema regression tests.

These tests verify the new flat shape returned by `/capabilities` and
`/gpu-info` after the Issue #939 refactor. CUDA is stubbed (re-using the
helper pattern from `test_pooling.py`); the v2a / music sidecar probes
are mocked via a stubbed `httpx`.

Run directly:
    python -m pytest sidecars/worker/test_capabilities.py -v
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))


def _make_torch_stub(device_count: int, vrams_gb: list[int]) -> MagicMock:
    cuda = MagicMock()
    cuda.is_available = MagicMock(return_value=device_count > 0)
    cuda.device_count = MagicMock(return_value=device_count)

    def _mem_get_info(i: int = 0) -> tuple[int, int]:
        gb = vrams_gb[i] if i < len(vrams_gb) else 0
        total = gb * 1024**3
        return (total // 2, total)

    cuda.mem_get_info = MagicMock(side_effect=_mem_get_info)
    cuda.get_device_properties = MagicMock(
        side_effect=lambda i: SimpleNamespace(total_memory=vrams_gb[i] * 1024**3)
    )
    cuda.get_device_name = MagicMock(side_effect=lambda i: f"FakeGPU-{i}")
    cuda.current_device = MagicMock(return_value=0)
    cuda.empty_cache = MagicMock()

    backends = MagicMock()
    backends.cudnn = MagicMock(benchmark=False)

    stub = MagicMock()
    stub.cuda = cuda
    stub.backends = backends
    stub.bfloat16 = "bfloat16"
    stub.float16 = "float16"
    return stub


def _make_httpx_stub(reachable: dict[int, bool], health_payloads: dict[int, dict] | None = None) -> MagicMock:
    """Stub httpx.get such that it returns 200 only for ports in `reachable=True`.

    For ports that need a structured /health response (e.g. 5013 for the
    ltx2 sidecar, where ``audio_modes`` gating reads ``ready`` from the
    JSON body), supply ``health_payloads={port: {"ready": True}}``.
    """
    payloads = health_payloads or {}

    def _get(url: str, timeout: float = 0.5):
        # crude: parse port from `http://localhost:PORT/...`
        try:
            port = int(url.split(":")[-1].split("/")[0])
        except Exception:
            port = -1
        ok = reachable.get(port, False)
        resp = MagicMock()
        resp.status_code = 200 if ok else 503
        resp.json = MagicMock(return_value=payloads.get(port, {}))
        if not ok:
            # Make it raise like a real ConnectError would for unreachable ports.
            raise RuntimeError(f"connection refused (stub): :{port}")
        return resp

    httpx = MagicMock()
    httpx.get = MagicMock(side_effect=_get)
    return httpx


@pytest.fixture
def server_module(monkeypatch):
    sys.modules.pop("server_cuda", None)
    import server_cuda as sc  # type: ignore  # noqa: E402

    yield sc
    sys.modules.pop("server_cuda", None)


def _install(sc, *, device_count: int, vrams_gb: list[int], reachable_ports: dict[int, bool], health_payloads: dict[int, dict] | None = None) -> None:
    sc.torch = _make_torch_stub(device_count, vrams_gb)
    sc.httpx = _make_httpx_stub(reachable_ports, health_payloads)


def _run(coro):
    return asyncio.run(coro)


# ── /capabilities shape ───────────────────────────────────────────────


def test_capabilities_returns_flat_schema(monkeypatch, server_module):
    """The new schema must include exactly the keys spec'd in #939."""
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_POOLING_MIN_VRAM_GB", 18)
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", False)
    _install(server_module, device_count=2, vrams_gb=[12, 12], reachable_ports={5012: True})

    out = _run(server_module.capabilities())

    # Required top-level keys (flat).
    for key in (
        "gpu_count", "gpus", "pooled_vram_gb", "pooling_active",
        "pooling_mode", "transformer_device", "encoder_device",
        "vae_device", "models", "audio_modes",
    ):
        assert key in out, f"missing key: {key}"

    # Old nested keys must be gone.
    for stale in ("pooling", "per_device", "max_frames", "env", "cuda_available", "device_count"):
        assert stale not in out, f"stale key still present: {stale}"


def test_capabilities_gpu_array_shape(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install(server_module, device_count=2, vrams_gb=[12, 24], reachable_ports={})

    out = _run(server_module.capabilities())
    assert out["gpu_count"] == 2
    assert isinstance(out["gpus"], list) and len(out["gpus"]) == 2
    g0 = out["gpus"][0]
    assert set(g0.keys()) == {"index", "name", "vram_gb"}
    assert g0["index"] == 0
    assert g0["name"] == "FakeGPU-0"
    assert g0["vram_gb"] == 12.0


def test_capabilities_models_array_shape(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install(server_module, device_count=2, vrams_gb=[12, 12], reachable_ports={})

    out = _run(server_module.capabilities())
    assert isinstance(out["models"], list) and len(out["models"]) > 0
    m0 = out["models"][0]
    # Issue #939 gap B: capabilities now exposes `requires_hf_token` (registry
    # flag for gated HF repos like Lightricks/LTX-Video-0.9.6-distilled, which
    # returns 401 without a token) and `hf_token_present` (live env check) so
    # the UI can warn before the user tries to load a gated model.
    # 2026-04-23 follow-up: also exposes `unavailable` + `unavailable_reason`
    # for entries with known upstream gaps.
    assert set(m0.keys()) == {
        "key", "max_frames", "max_seconds_at_24fps", "synchronized_audio",
        "requires_hf_token", "hf_token_present",
        "unavailable", "unavailable_reason",
    }
    assert isinstance(m0["max_frames"], int)
    assert isinstance(m0["max_seconds_at_24fps"], float)
    assert isinstance(m0["requires_hf_token"], bool)
    assert isinstance(m0["hf_token_present"], bool)


# ── audio_modes gating ────────────────────────────────────────────────


def test_audio_modes_only_off_when_no_sidecars(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", False)
    _install(server_module, device_count=1, vrams_gb=[12], reachable_ports={})

    out = _run(server_module.capabilities())
    assert out["audio_modes"] == ["off"], out["audio_modes"]


def test_audio_modes_includes_auto_when_v2a_reachable(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", False)
    _install(server_module, device_count=1, vrams_gb=[12], reachable_ports={5012: True})

    out = _run(server_module.capabilities())
    assert "auto" in out["audio_modes"]
    assert "music" not in out["audio_modes"]


def test_audio_modes_includes_music_when_5009_reachable(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", False)
    _install(server_module, device_count=1, vrams_gb=[12], reachable_ports={5009: True})

    out = _run(server_module.capabilities())
    assert "music" in out["audio_modes"]


def test_audio_modes_includes_native_when_ltx2_sidecar_ready(monkeypatch, server_module):
    """2026-04-24: native audio is now gated on the ltx2 sidecar (port 5013)
    reporting `ready: True` from /health, NOT pooled VRAM. The sidecar
    enforces hardware requirements itself (CPU offload works on 12 GB+)."""
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "off")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", True)
    _install(
        server_module,
        device_count=1, vrams_gb=[12],
        reachable_ports={5013: True},
        health_payloads={5013: {"ready": True}},
    )

    out = _run(server_module.capabilities())
    assert "native" in out["audio_modes"], out["audio_modes"]


def test_audio_modes_excludes_native_when_ltx2_sidecar_unreachable(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "off")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", True)
    _install(server_module, device_count=1, vrams_gb=[12], reachable_ports={})

    out = _run(server_module.capabilities())
    assert "native" not in out["audio_modes"]


def test_audio_modes_excludes_native_when_sidecar_reachable_but_not_ready(monkeypatch, server_module):
    """Sidecar process up but venv/models missing → /health returns ready=False."""
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "off")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", True)
    _install(
        server_module,
        device_count=1, vrams_gb=[12],
        reachable_ports={5013: True},
        health_payloads={5013: {"ready": False}},
    )

    out = _run(server_module.capabilities())
    assert "native" not in out["audio_modes"]


def test_audio_modes_includes_native_even_when_ltx_allow_audio_false(monkeypatch, server_module):
    """2026-04-24 regression: LTX_ALLOW_AUDIO gates the worker's IN-PROCESS
    audio path only — the dedicated ltx2 sidecar is its own opt-in (it has
    to be launched and pass /health). When the sidecar is healthy, native
    must be advertised regardless of LTX_ALLOW_AUDIO. This was a real walk-
    through bug where the user's normal `start-cuda-sidecars.sh` launch
    didn't set LTX_ALLOW_AUDIO=1, suppressing native even though the
    sidecar was running."""
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "off")
    monkeypatch.setattr(server_module, "LTX_ALLOW_AUDIO", False)
    _install(
        server_module,
        device_count=1, vrams_gb=[12],
        reachable_ports={5013: True},
        health_payloads={5013: {"ready": True}},
    )

    out = _run(server_module.capabilities())
    assert "native" in out["audio_modes"], out["audio_modes"]


# ── /gpu-info pooling fields ──────────────────────────────────────────


def test_gpu_info_includes_pooling_fields(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_POOLING_MIN_VRAM_GB", 18)
    _install(server_module, device_count=2, vrams_gb=[12, 12], reachable_ports={})

    out = _run(server_module.gpu_info_endpoint())
    for key in (
        "pooling_mode", "pooling_active", "transformer_device",
        "encoder_device", "vae_device", "pooled_vram_gb", "gpus",
    ):
        assert key in out, f"missing key: {key}"
    assert out["pooling_active"] is True
    assert isinstance(out["gpus"], list) and len(out["gpus"]) == 2
    assert {"index", "name", "vram_gb", "free_gb"} <= set(out["gpus"][0].keys())


def test_gpu_info_unavailable_path_still_has_pooling_keys(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install(server_module, device_count=0, vrams_gb=[], reachable_ports={})

    out = _run(server_module.gpu_info_endpoint())
    assert out["available"] is False
    assert out["pooling_active"] is False
    assert out["gpus"] == []
    assert out["pooled_vram_gb"] == 0


# ── /generate-extended is gone ────────────────────────────────────────


def test_generate_extended_endpoint_removed(server_module):
    """Issue #939: worker-side /generate-extended must no longer exist."""
    routes = {r.path for r in server_module.app.routes}
    assert "/generate-extended" not in routes
    assert not hasattr(server_module, "run_extended_generation_job")
    assert not hasattr(server_module, "GenerateExtendedRequest")
