"""OOM-recovery + VRAM-fragmentation tests for the FluxQ sidecar (issue #1022).

Pins the contract of the sidecar's CUDA-OOM self-heal path so future edits
don't silently regress the bulk-pitch-fan-out fix:

  * `_is_cuda_oom`            — detects torch.cuda.OutOfMemoryError AND legacy
                                RuntimeError("CUDA out of memory") variants.
  * `_empty_cuda_cache`        — never raises even when torch is missing.
  * `_generate_image_with_oom_recovery` — three-step ladder:
        1. first OOM   → empty_cache, retry
        2. second OOM → unload+reload, retry
        3. third OOM  → re-raise
  * Module-import side effect — sets PYTORCH_CUDA_ALLOC_CONF before torch
    is imported (the env var is the single highest-leverage fragmentation
    fix on a 12 GB card).

Run directly:
    python -m pytest sidecars/image-gen/test_oom_recovery.py -v
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure server_cuda imports without a GPU/torch installed on the runner.
_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

import server_cuda  # noqa: E402


# ── Module-level env init (issue #1022, layer 1) ────────────────────


def test_pytorch_cuda_alloc_conf_default_set_on_import() -> None:
    """The sidecar must set ``PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True``
    at import time (before any ``import torch``). This is the single highest-
    leverage fragmentation fix on 12 GB GPUs."""
    val = os.environ.get("PYTORCH_CUDA_ALLOC_CONF", "")
    assert "expandable_segments:True" in val, (
        f"expected expandable_segments:True in PYTORCH_CUDA_ALLOC_CONF, got {val!r}"
    )


# ── _is_cuda_oom ─────────────────────────────────────────────────────


def test_is_cuda_oom_matches_runtime_error_message() -> None:
    """Older torch wheels raise RuntimeError, not OutOfMemoryError. Detect both."""
    err = RuntimeError(
        "CUDA out of memory. Tried to allocate 72.00 MiB. GPU 0 has 12.00 GiB total"
    )
    assert server_cuda._is_cuda_oom(err) is True


def test_is_cuda_oom_matches_outofmemoryerror_class() -> None:
    """When torch.cuda.OutOfMemoryError is available, isinstance check wins."""

    class FakeOOM(RuntimeError):
        pass

    class FakeCuda:
        OutOfMemoryError = FakeOOM

    class FakeTorch:
        cuda = FakeCuda

    with patch.object(server_cuda, "torch", FakeTorch):
        assert server_cuda._is_cuda_oom(FakeOOM("oom")) is True
        # Unrelated error of the same base class is not OOM
        assert server_cuda._is_cuda_oom(RuntimeError("nope")) is False


def test_is_cuda_oom_rejects_unrelated_errors() -> None:
    assert server_cuda._is_cuda_oom(ValueError("bad input")) is False
    assert server_cuda._is_cuda_oom(Exception("disk full")) is False


# ── _empty_cuda_cache ────────────────────────────────────────────────


def test_empty_cuda_cache_is_safe_when_torch_unavailable() -> None:
    """Must never raise — used in `finally` blocks where exceptions would
    mask the real error."""
    with patch.object(server_cuda, "torch", None):
        server_cuda._empty_cuda_cache()  # no exception


def test_empty_cuda_cache_calls_empty_cache_when_cuda_available() -> None:
    calls: list[str] = []

    class FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return True

        @staticmethod
        def empty_cache() -> None:
            calls.append("empty_cache")

        @staticmethod
        def ipc_collect() -> None:
            calls.append("ipc_collect")

    class FakeTorch:
        cuda = FakeCuda

    with patch.object(server_cuda, "torch", FakeTorch):
        server_cuda._empty_cuda_cache()

    assert "empty_cache" in calls


# ── _generate_image_with_oom_recovery ────────────────────────────────


@pytest.fixture
def dummy_image() -> object:
    """Sentinel — we don't care about the actual PIL.Image type."""

    class Sentinel:
        pass

    return Sentinel()


def test_recovery_returns_first_call_when_no_oom(dummy_image: object) -> None:
    """Happy path — ``_generate_image`` succeeds first time."""
    with patch.object(
        server_cuda, "_generate_image", return_value=dummy_image
    ) as gi, patch.object(server_cuda, "_empty_cuda_cache") as ec:
        out = server_cuda._generate_image_with_oom_recovery(
            "p", "flux-schnell", 1024, 576, None, 0.0, 1
        )
    assert out is dummy_image
    assert gi.call_count == 1
    ec.assert_not_called()  # no OOM → no recovery cleanup needed


def test_recovery_succeeds_after_one_oom(dummy_image: object) -> None:
    """First call OOMs, ``empty_cache()`` runs, second call succeeds.

    Asserts:
      * ``empty_cuda_cache`` was called between attempts.
      * ``_unload_model`` was NOT called (only fires on the 2nd OOM).
      * The function returns the recovered image, not the OOM.
    """
    oom = RuntimeError("CUDA out of memory.")
    with patch.object(
        server_cuda, "_generate_image", side_effect=[oom, dummy_image]
    ) as gi, patch.object(server_cuda, "_empty_cuda_cache") as ec, patch.object(
        server_cuda, "_unload_model"
    ) as ul:
        out = server_cuda._generate_image_with_oom_recovery(
            "p", "flux-schnell", 1024, 576, None, 0.0, 1
        )
    assert out is dummy_image
    assert gi.call_count == 2
    assert ec.call_count == 1
    ul.assert_not_called()


def test_recovery_unloads_and_reloads_after_two_ooms(dummy_image: object) -> None:
    """Two OOMs trigger unload+reload; third call succeeds."""
    oom = RuntimeError("CUDA out of memory.")
    with patch.object(
        server_cuda,
        "_generate_image",
        side_effect=[oom, oom, dummy_image],
    ) as gi, patch.object(server_cuda, "_empty_cuda_cache") as ec, patch.object(
        server_cuda, "_unload_model"
    ) as ul:
        out = server_cuda._generate_image_with_oom_recovery(
            "p", "flux-schnell", 1024, 576, None, 0.0, 1
        )
    assert out is dummy_image
    assert gi.call_count == 3
    assert ul.call_count == 1
    # empty_cache fires after every OOM (twice — once per recovery layer)
    assert ec.call_count == 2


def test_recovery_reraises_after_three_ooms() -> None:
    """All three attempts OOM → re-raise so the caller can fail the job."""
    oom = RuntimeError("CUDA out of memory. Tried to allocate 72 MiB.")
    with patch.object(
        server_cuda, "_generate_image", side_effect=[oom, oom, oom]
    ) as gi, patch.object(server_cuda, "_empty_cuda_cache"), patch.object(
        server_cuda, "_unload_model"
    ):
        with pytest.raises(RuntimeError, match="out of memory"):
            server_cuda._generate_image_with_oom_recovery(
                "p", "flux-schnell", 1024, 576, None, 0.0, 1
            )
    assert gi.call_count == 3


def test_recovery_does_not_swallow_non_oom_errors() -> None:
    """A ValueError must propagate immediately — no retry, no unload."""
    with patch.object(
        server_cuda, "_generate_image", side_effect=ValueError("bad prompt")
    ) as gi, patch.object(server_cuda, "_empty_cuda_cache") as ec, patch.object(
        server_cuda, "_unload_model"
    ) as ul:
        with pytest.raises(ValueError, match="bad prompt"):
            server_cuda._generate_image_with_oom_recovery(
                "p", "flux-schnell", 1024, 576, None, 0.0, 1
            )
    assert gi.call_count == 1
    ec.assert_not_called()
    ul.assert_not_called()


def test_recovery_does_not_swallow_non_oom_on_retry(dummy_image: object) -> None:
    """First call OOMs, second call raises a different error → propagate it
    (do NOT mask it with another retry or with an OOM)."""
    oom = RuntimeError("CUDA out of memory.")
    other = ValueError("invalid latent shape")
    with patch.object(
        server_cuda, "_generate_image", side_effect=[oom, other]
    ) as gi, patch.object(server_cuda, "_empty_cuda_cache"), patch.object(
        server_cuda, "_unload_model"
    ) as ul:
        with pytest.raises(ValueError, match="invalid latent shape"):
            server_cuda._generate_image_with_oom_recovery(
                "p", "flux-schnell", 1024, 576, None, 0.0, 1
            )
    assert gi.call_count == 2
    ul.assert_not_called()  # didn't reach the unload layer
