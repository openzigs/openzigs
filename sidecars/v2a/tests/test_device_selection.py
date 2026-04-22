"""Mocked device-selection tests for the v2a sidecar.

These tests fully mock ``torch.cuda`` so they run on any host (CI, dev
laptops without GPUs, etc.) without requiring real CUDA hardware.

Coverage:
  1. Single 12 GB GPU -> cuda:0
  2. Dual identical 12 GB -> cuda:0 (tie-break to lowest index)
  3. Dual heterogeneous (12 GB + 24 GB) -> picks the 24 GB device
  4. Env override V2A_DEVICE=cuda:1 -> returned verbatim
  5. No CUDA -> RuntimeError with actionable message
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest

# Make the sidecar package importable without installing it.
SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


def _install_fake_torch(
    *,
    cuda_available: bool,
    device_count: int,
    totals_gb: list[int] | None = None,
) -> types.SimpleNamespace:
    """Install a fake `torch` module on `server_cuda` and return it.

    `totals_gb` lists the total VRAM (in GB) for each device index; required
    when `cuda_available=True` and `device_count >= 1`.
    """
    fake_torch = types.SimpleNamespace()
    cuda = types.SimpleNamespace()

    cuda.is_available = lambda: cuda_available
    cuda.device_count = lambda: device_count

    if totals_gb is None:
        totals_gb = []

    def mem_get_info(idx: int = 0):
        if idx >= len(totals_gb):
            raise RuntimeError(f"invalid device index {idx}")
        total = totals_gb[idx] * (1024**3)
        # Pretend free == 90% of total for deterministic assertions.
        return int(total * 0.9), total

    cuda.mem_get_info = mem_get_info

    class _Props:
        def __init__(self, total_memory: int) -> None:
            self.total_memory = total_memory

    cuda.get_device_properties = lambda i: _Props(totals_gb[i] * (1024**3))

    # cudnn backend stub for the `_ensure_torch` benchmark toggle.
    fake_torch.cuda = cuda
    fake_torch.backends = types.SimpleNamespace(
        cudnn=types.SimpleNamespace(benchmark=False),
    )

    import server_cuda  # noqa: WPS433  (intentional late import)
    server_cuda.torch = fake_torch
    server_cuda._reset_selected_device_for_tests()
    return fake_torch


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Ensure each test starts with a clean slate of relevant env vars."""
    monkeypatch.delenv("V2A_DEVICE", raising=False)
    monkeypatch.delenv("V2A_PREFER_LARGER_GPU", raising=False)
    monkeypatch.delenv("V2A_FALLBACK_TO_CPU", raising=False)
    yield
    # Force re-selection in the next test so cached state never bleeds across.
    import server_cuda
    server_cuda._reset_selected_device_for_tests()


def test_single_12gb_gpu_picks_cuda0(monkeypatch):
    _install_fake_torch(cuda_available=True, device_count=1, totals_gb=[12])
    # Stub _ensure_torch so it doesn't try to `import torch`.
    import server_cuda
    monkeypatch.setattr(server_cuda, "_ensure_torch", lambda: None)
    device, reason = server_cuda._select_device()
    assert device == "cuda:0"
    assert reason == "auto"


def test_dual_identical_12gb_picks_cuda0(monkeypatch):
    _install_fake_torch(cuda_available=True, device_count=2, totals_gb=[12, 12])
    import server_cuda
    monkeypatch.setattr(server_cuda, "_ensure_torch", lambda: None)
    device, reason = server_cuda._select_device()
    # Tie-break: first device wins because strict `>` comparison keeps best_idx=0.
    assert device == "cuda:0"
    assert reason == "auto"


def test_dual_heterogeneous_picks_larger_gpu(monkeypatch):
    # cuda:0 = 12 GB, cuda:1 = 24 GB -> larger wins.
    _install_fake_torch(cuda_available=True, device_count=2, totals_gb=[12, 24])
    import server_cuda
    monkeypatch.setattr(server_cuda, "_ensure_torch", lambda: None)
    device, reason = server_cuda._select_device()
    assert device == "cuda:1"
    assert reason == "auto"


def test_env_override_wins_over_auto(monkeypatch):
    # Even with two GPUs visible, V2A_DEVICE=cuda:1 must be returned verbatim
    # without consulting mem_get_info or device_count.
    monkeypatch.setenv("V2A_DEVICE", "cuda:1")
    _install_fake_torch(cuda_available=True, device_count=2, totals_gb=[24, 12])
    import server_cuda
    monkeypatch.setattr(server_cuda, "_ensure_torch", lambda: None)
    device, reason = server_cuda._select_device()
    assert device == "cuda:1"
    assert reason == "env-override"


def test_no_cuda_raises_runtime_error(monkeypatch):
    _install_fake_torch(cuda_available=False, device_count=0)
    import server_cuda
    monkeypatch.setattr(server_cuda, "_ensure_torch", lambda: None)
    with pytest.raises(RuntimeError) as exc_info:
        server_cuda._select_device()
    msg = str(exc_info.value)
    # Message must be actionable per the user spec.
    assert "V2A sidecar requires CUDA" in msg
    assert "V2A_DEVICE=cuda:0" in msg


def test_prefer_larger_disabled_falls_back_to_cuda0(monkeypatch):
    # With V2A_PREFER_LARGER_GPU=0, the larger card on cuda:1 must be ignored
    # and cuda:0 used for backward compatibility.
    monkeypatch.setenv("V2A_PREFER_LARGER_GPU", "0")
    _install_fake_torch(cuda_available=True, device_count=2, totals_gb=[12, 24])
    import server_cuda
    monkeypatch.setattr(server_cuda, "_ensure_torch", lambda: None)
    device, reason = server_cuda._select_device()
    assert device == "cuda:0"
    assert reason == "auto"
