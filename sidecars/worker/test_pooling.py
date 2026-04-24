"""WS2-A (#927) regression tests for dual-GPU LTX sharding logic.

These tests exercise the pure helper functions that decide whether to
shard the LTX pipeline across multiple GPUs and what frame ceiling to
apply. They run without a real CUDA device by stubbing
``torch.cuda.device_count()``, ``torch.cuda.is_available()``, and
``torch.cuda.mem_get_info(i)``.

The matrix below mirrors the configurability matrix in the PR body:

  | topology       | device_count | per-card VRAM | expected pooling | tier |
  |----------------|-------------|---------------|------------------|------|
  | 1x12GB         | 1           | 12 GB         | off              | 10   |
  | 2x12GB         | 2           | 12 GB         | active           | 24   |
  | 1x24GB         | 1           | 24 GB         | off              | 22   |
  | 2x24GB         | 2           | 24 GB         | active           | 48   |
  | mixed 12+24    | 2           | 12, 24 GB     | active           | 32+  |

Run directly:
    python -m pytest sidecars/worker/test_pooling.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))


def _make_torch_stub(device_count: int, vrams_gb: list[int]) -> MagicMock:
    """Build a torch stub whose `cuda` namespace mirrors the requested topology.

    `vrams_gb` is the per-device total VRAM in GB; mem_get_info returns
    (free, total) tuples in bytes.
    """
    cuda = MagicMock()
    cuda.is_available = MagicMock(return_value=device_count > 0)
    cuda.device_count = MagicMock(return_value=device_count)

    def _mem_get_info(i: int = 0) -> tuple[int, int]:
        gb = vrams_gb[i] if i < len(vrams_gb) else 0
        total = gb * 1024**3
        # Pretend half is free.
        return (total // 2, total)

    cuda.mem_get_info = MagicMock(side_effect=_mem_get_info)
    cuda.get_device_properties = MagicMock(
        side_effect=lambda i: SimpleNamespace(total_memory=vrams_gb[i] * 1024**3)
    )
    cuda.get_device_name = MagicMock(side_effect=lambda i: f"FakeGPU-{i}")

    backends = MagicMock()
    backends.cudnn = MagicMock(benchmark=False)
    cuda.empty_cache = MagicMock()

    stub = MagicMock()
    stub.cuda = cuda
    stub.backends = backends
    stub.bfloat16 = "bfloat16"
    stub.float16 = "float16"
    return stub


@pytest.fixture
def server_module(monkeypatch):
    """Import server_cuda fresh and inject a torch stub.

    Each test gets a fresh import so monkeypatched env vars take effect.
    """
    # Force re-import so module-level env reads pick up monkeypatched values.
    sys.modules.pop("server_cuda", None)
    import server_cuda as sc  # type: ignore  # noqa: E402

    yield sc

    sys.modules.pop("server_cuda", None)


def _install_torch(sc, device_count: int, vrams_gb: list[int]) -> None:
    sc.torch = _make_torch_stub(device_count, vrams_gb)


# ── Topology: 1×12 GB (single low-VRAM card) ──────────────────────────


def test_pooling_off_for_single_12gb_card_in_auto_mode(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_POOLING_MIN_VRAM_GB", 18)
    _install_torch(server_module, device_count=1, vrams_gb=[12])

    assert server_module._is_pooling_active() is False
    assert server_module._get_pooled_vram_gb() == 12
    # Single 12 GB card -> 13B model uses 12 GB tier -> 57 frames.
    assert server_module._get_max_frames_for_model("ltxv-13b-097-distilled") == 57


# ── Topology: 2×12 GB (the headline pooled case) ──────────────────────


def test_pooling_active_for_dual_12gb_in_auto_mode(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_POOLING_MIN_VRAM_GB", 18)
    _install_torch(server_module, device_count=2, vrams_gb=[12, 12])

    assert server_module._is_pooling_active() is True
    assert server_module._get_pooled_vram_gb() == 24
    # Pooled 24 GB tier -> 13B gets 161 frames (full capacity).
    assert server_module._get_max_frames_for_model("ltxv-13b-097-distilled") == 161


# ── Topology: 1×24 GB (single high-VRAM card) ─────────────────────────


def test_pooling_off_for_single_24gb_card(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install_torch(server_module, device_count=1, vrams_gb=[24])

    assert server_module._is_pooling_active() is False
    # Single 24 GB card hits the 22 GB tier -> 161 frames.
    assert server_module._get_max_frames_for_model("ltxv-13b-097-distilled") == 161


# ── Topology: 2×24 GB (workstation) ───────────────────────────────────


def test_pooling_active_for_dual_24gb_promotes_to_48gb_tier(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install_torch(server_module, device_count=2, vrams_gb=[24, 24])

    assert server_module._is_pooling_active() is True
    assert server_module._get_pooled_vram_gb() == 48
    # 48 GB tier -> 257 frames (the highest tier we configure).
    assert server_module._get_max_frames_for_model("ltxv-13b-097-distilled") == 257


# ── Topology: mismatched 12 + 24 GB (real-world heterogeneous) ────────


def test_pooling_active_for_mismatched_12_plus_24gb(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install_torch(server_module, device_count=2, vrams_gb=[12, 24])

    assert server_module._is_pooling_active() is True
    assert server_module._get_pooled_vram_gb() == 36
    # 36 GB pooled -> falls into the 32 GB tier -> 201 frames.
    assert server_module._get_max_frames_for_model("ltxv-13b-097-distilled") == 201


# ── Mode overrides ────────────────────────────────────────────────────


def test_pooling_off_mode_disables_even_with_two_cards(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "off")
    _install_torch(server_module, device_count=2, vrams_gb=[24, 24])

    assert server_module._is_pooling_active() is False


def test_pooling_manual_mode_requires_two_cards(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "manual")
    _install_torch(server_module, device_count=1, vrams_gb=[24])

    assert server_module._is_pooling_active() is False


def test_pooling_manual_mode_activates_with_two_cards_below_threshold(
    monkeypatch, server_module
):
    """Manual mode bypasses LTX_POOLING_MIN_VRAM_GB."""
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "manual")
    monkeypatch.setattr(server_module, "LTX_POOLING_MIN_VRAM_GB", 100)
    _install_torch(server_module, device_count=2, vrams_gb=[8, 8])

    assert server_module._is_pooling_active() is True


def test_pooling_auto_falls_back_when_below_min_vram(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    monkeypatch.setattr(server_module, "LTX_POOLING_MIN_VRAM_GB", 30)
    _install_torch(server_module, device_count=2, vrams_gb=[12, 12])

    assert server_module._is_pooling_active() is False


# ── Override env var ──────────────────────────────────────────────────


def test_max_frames_override_takes_precedence(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_MAX_FRAMES_OVERRIDE", 49)
    _install_torch(server_module, device_count=2, vrams_gb=[24, 24])

    assert server_module._get_max_frames_for_model("ltxv-13b-097-distilled") == 49
    assert server_module._get_max_frames_for_model("ltxv-2-22b-distilled") == 49


# ── 22B (LTX-2) frame tiers (#926) ────────────────────────────────────


def test_ltxv2_22b_frame_limits_match_pooled_tiers(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "auto")
    _install_torch(server_module, device_count=2, vrams_gb=[12, 12])

    # Pooled 24 GB 22B tier -> 161 frames.
    assert server_module._get_max_frames_for_model("ltxv-2-22b-distilled") == 161


def test_ltxv2_22b_falls_back_on_unknown_topology(monkeypatch, server_module):
    monkeypatch.setattr(server_module, "LTX_POOLING_MODE", "off")
    _install_torch(server_module, device_count=1, vrams_gb=[4])

    # 4 GB doesn't match any tier -> conservative 22B fallback (49).
    assert server_module._get_max_frames_for_model("ltxv-2-22b-distilled") == 49


# ── Registry exposes the new model ────────────────────────────────────


def test_ltxv2_22b_distilled_registered_with_audio_flag(server_module):
    # NOTE (#940 follow-up, 2026-04-24): registry KEY preserved as
    # `ltxv-2-22b-distilled` for backwards compat, but the underlying
    # spec has been corrected to point at the real public repo
    # `Lightricks/LTX-2` (19B params, NOT 22B; pipeline is `LTX2Pipeline`).
    # The model is now served by the dedicated ltx2 sidecar (port 5013)
    # via the upstream native ``ltx_pipelines.distilled`` CLI, so the
    # worker's `unavailable=True` block has been removed and a
    # `served_by_sidecar` marker added so the worker's in-process
    # generate path refuses to load it.
    spec = server_module.VIDEO_MODEL_REGISTRY["ltxv-2-22b-distilled"]
    assert spec["synchronized_audio"] is True
    assert spec["pipeline_class"] == "LTX2Pipeline"
    assert spec["hf_id"] == "Lightricks/LTX-2"
    assert spec.get("unavailable") is not True
    assert spec.get("served_by_sidecar") == "http://localhost:5013"
