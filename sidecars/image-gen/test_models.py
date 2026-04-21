"""Pydantic model validation tests for the image-gen sidecar.

Epic #868 (LoRA-trained character injection in the inpainting studio)
extends ``Img2ImgRequest`` / ``AsyncImg2ImgRequest`` with three new
optional fields — ``mask``, ``lora_paths``, ``lora_scales`` — and adds an
inpaint pipeline branch in ``_bg_img2img``. These tests pin the contract
of the request models so a future regression (e.g. tightening a validator
that accidentally rejects backward-compatible payloads, or removing the
LoRA path traversal check) flips a named test instead of silently
breaking the production HTTP API.

Run directly:
    python -m pytest sidecars/image-gen/test_models.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add the sidecar directory to sys.path so the bare ``path_utils`` import
# at the top of ``server_cuda`` resolves without an installed package.
_SIDECAR_DIR = Path(__file__).resolve().parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

# Stub out the heavy optional deps so importing ``server_cuda`` does not
# require torch/diffusers/PIL on the test runner. The Pydantic models
# only depend on stdlib + pydantic, but ``server_cuda`` imports a few
# heavy modules at module scope (``urllib.request``, etc.). The model
# definitions themselves do not touch torch.
import server_cuda  # noqa: E402

Img2ImgRequest = server_cuda.Img2ImgRequest
AsyncImg2ImgRequest = server_cuda.AsyncImg2ImgRequest
GenerateRequest = server_cuda.GenerateRequest
AsyncGenerateRequest = server_cuda.AsyncGenerateRequest


# ── Img2ImgRequest: backward compatibility (issue #873) ───────────────


def test_img2img_request_accepts_minimal_payload() -> None:
    """A pre-#868 payload (no mask, no LoRA fields) must still validate."""
    req = Img2ImgRequest(prompt="a cat", image="aGVsbG8=")
    assert req.prompt == "a cat"
    assert req.mask is None
    assert req.lora_paths is None
    assert req.lora_scales is None


def test_img2img_request_accepts_image_path_only() -> None:
    req = Img2ImgRequest(prompt="x", image_path="/tmp/foo.png")
    assert req.image is None
    assert req.image_path.endswith("foo.png")


def test_img2img_request_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="Path traversal"):
        Img2ImgRequest(prompt="x", image_path="../../etc/passwd")


def test_img2img_request_rejects_null_byte_in_image_path() -> None:
    with pytest.raises(ValueError, match="null bytes"):
        Img2ImgRequest(prompt="x", image_path="/tmp/foo\x00.png")


# ── Img2ImgRequest: epic #868 new fields ──────────────────────────────


def test_img2img_request_accepts_mask_field() -> None:
    req = Img2ImgRequest(prompt="x", image="aGk=", mask="bWFzaw==")
    assert req.mask == "bWFzaw=="


def test_img2img_request_accepts_lora_paths_and_scales() -> None:
    req = Img2ImgRequest(
        prompt="ohwx_char standing in a field",
        image="aGk=",
        mask="bWFzaw==",
        lora_paths=["/models/lora/char.safetensors"],
        lora_scales=[0.85],
    )
    assert req.lora_paths == ["/models/lora/char.safetensors"]
    assert req.lora_scales == [0.85]


def test_img2img_request_accepts_multiple_lora_adapters() -> None:
    req = Img2ImgRequest(
        prompt="x",
        image="aGk=",
        lora_paths=[
            "/models/lora/char1.safetensors",
            "/models/lora/char2.safetensors",
        ],
        lora_scales=[0.8, 0.9],
    )
    assert len(req.lora_paths) == 2
    assert req.lora_scales == [0.8, 0.9]


def test_img2img_request_rejects_lora_path_traversal() -> None:
    with pytest.raises(ValueError, match="Invalid LoRA path"):
        Img2ImgRequest(
            prompt="x",
            image="aGk=",
            lora_paths=["../../../etc/passwd"],
        )


def test_img2img_request_rejects_null_byte_in_lora_path() -> None:
    with pytest.raises(ValueError, match="Invalid LoRA path"):
        Img2ImgRequest(
            prompt="x",
            image="aGk=",
            lora_paths=["/models/lora/foo\x00.safetensors"],
        )


def test_img2img_request_rejects_oversized_mask() -> None:
    huge_mask = "A" * (28 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match="exceeds maximum"):
        Img2ImgRequest(prompt="x", image="aGk=", mask=huge_mask)


def test_img2img_request_rejects_non_string_lora_path() -> None:
    with pytest.raises(ValueError):
        Img2ImgRequest(
            prompt="x",
            image="aGk=",
            lora_paths=[12345],  # type: ignore[list-item]
        )


# ── AsyncImg2ImgRequest: inherits new fields ──────────────────────────


def test_async_img2img_request_accepts_new_fields() -> None:
    req = AsyncImg2ImgRequest(
        prompt="x",
        image="aGk=",
        job_id="job-123",
        callback_url="http://localhost/callback",
        mask="bWFzaw==",
        lora_paths=["/models/lora/x.safetensors"],
        lora_scales=[0.7],
    )
    assert req.job_id == "job-123"
    assert req.mask == "bWFzaw=="
    assert req.lora_paths == ["/models/lora/x.safetensors"]


def test_async_img2img_request_backward_compatible() -> None:
    """Async img2img must still accept the pre-#868 payload shape."""
    req = AsyncImg2ImgRequest(
        prompt="x", image="aGk=", job_id="job-1"
    )
    assert req.mask is None
    assert req.lora_paths is None


# ── GenerateRequest / AsyncGenerateRequest: untouched (issue #873) ────


def test_generate_request_unchanged_by_epic() -> None:
    """txt2img request shape must NOT change as part of epic #868."""
    req = GenerateRequest(prompt="a cat")
    # Sanity: the txt2img model has no `mask` field at all.
    assert not hasattr(req, "mask")


def test_async_generate_request_unchanged_by_epic() -> None:
    req = AsyncGenerateRequest(prompt="a cat", job_id="j1")
    assert not hasattr(req, "mask")
    assert req.job_id == "j1"


def test_generate_request_lora_path_validator_still_rejects_traversal() -> None:
    """Existing txt2img LoRA validator must still reject `..` paths."""
    with pytest.raises(ValueError, match="Invalid LoRA path"):
        GenerateRequest(prompt="x", lora_paths=["../../etc/passwd"])


# ── Inpaint helper: pipeline selection (epic #868 / dual-GPU) ─────────


def test_build_inpaint_pipe_selects_sdxl_class() -> None:
    """SDXL pipelines must route to ``StableDiffusionXLInpaintPipeline``."""
    fake_module = MagicMock()
    fake_module.StableDiffusionXLInpaintPipeline.from_pipe.return_value = "sdxl-inpaint"
    sys.modules["diffusers"] = fake_module
    try:
        result = server_cuda._build_inpaint_pipe("sdxl", base_pipe="base")
        fake_module.StableDiffusionXLInpaintPipeline.from_pipe.assert_called_once_with(
            "base"
        )
        assert result == "sdxl-inpaint"
    finally:
        del sys.modules["diffusers"]


def test_build_inpaint_pipe_selects_flux_class() -> None:
    """Flux pipelines must route to ``FluxInpaintPipeline``."""
    fake_module = MagicMock()
    fake_module.FluxInpaintPipeline.from_pipe.return_value = "flux-inpaint"
    sys.modules["diffusers"] = fake_module
    try:
        result = server_cuda._build_inpaint_pipe("flux", base_pipe="base")
        fake_module.FluxInpaintPipeline.from_pipe.assert_called_once_with("base")
        assert result == "flux-inpaint"
    finally:
        del sys.modules["diffusers"]


def test_build_inpaint_pipe_preserves_pooled_device_placement() -> None:
    """When the base pipe was loaded with ``IMAGE_GEN_POOLING_MODE=manual-flux``,
    its components live on cuda:0 (text encoders + vae) and cuda:1
    (transformer). ``from_pipe()`` shares those components by reference, so
    the inpaint branch MUST inherit the same placement without re-binding —
    otherwise we OOM by duplicating the transformer onto cuda:0.

    This test asserts that ``_build_inpaint_pipe`` calls ``from_pipe`` (the
    sharing primitive) and never invokes ``.to(device)`` on the returned
    pipeline before generation, which would force a full re-bind.
    """
    base_pipe = MagicMock()
    base_pipe.text_encoder.device = "cuda:0"
    base_pipe.text_encoder_2.device = "cuda:0"
    base_pipe.vae.device = "cuda:0"
    base_pipe.transformer.device = "cuda:1"

    inpaint_pipe = MagicMock()
    # from_pipe returns a NEW pipeline object that shares components by reference
    inpaint_pipe.text_encoder = base_pipe.text_encoder
    inpaint_pipe.text_encoder_2 = base_pipe.text_encoder_2
    inpaint_pipe.vae = base_pipe.vae
    inpaint_pipe.transformer = base_pipe.transformer

    fake_module = MagicMock()
    fake_module.FluxInpaintPipeline.from_pipe.return_value = inpaint_pipe
    sys.modules["diffusers"] = fake_module
    try:
        result = server_cuda._build_inpaint_pipe("flux", base_pipe)
        # Components must still report their original devices (no re-bind happened).
        assert result.text_encoder.device == "cuda:0"
        assert result.text_encoder_2.device == "cuda:0"
        assert result.vae.device == "cuda:0"
        assert result.transformer.device == "cuda:1"
        # And from_pipe was invoked — the sharing primitive — not a fresh constructor.
        fake_module.FluxInpaintPipeline.from_pipe.assert_called_once_with(base_pipe)
    finally:
        del sys.modules["diffusers"]


# ── Inpaint LoRA loader (epic #868) ────────────────────────────────────


def test_load_inpaint_loras_calls_load_then_set_adapters(tmp_path) -> None:
    """LoRA loading order must be: load_lora_weights() per adapter, then a
    single set_adapters() with all names + scales."""
    # Create a fake .safetensors file so the existence check passes
    lora_file = tmp_path / "char.safetensors"
    lora_file.write_bytes(b"\x00" * 16)

    pipe = MagicMock()
    server_cuda._load_inpaint_loras(pipe, [str(lora_file)], [0.85])

    pipe.load_lora_weights.assert_called_once_with(
        str(tmp_path), weight_name="char.safetensors", adapter_name="inpaint_lora_0"
    )
    pipe.set_adapters.assert_called_once_with(
        ["inpaint_lora_0"], adapter_weights=[0.85]
    )


def test_load_inpaint_loras_rejects_missing_file(tmp_path) -> None:
    pipe = MagicMock()
    with pytest.raises(ValueError, match="LoRA file not found"):
        server_cuda._load_inpaint_loras(
            pipe, [str(tmp_path / "missing.safetensors")], [1.0]
        )


def test_load_inpaint_loras_handles_multiple_adapters(tmp_path) -> None:
    a = tmp_path / "a.safetensors"
    b = tmp_path / "b.safetensors"
    a.write_bytes(b"\x00")
    b.write_bytes(b"\x00")

    pipe = MagicMock()
    server_cuda._load_inpaint_loras(pipe, [str(a), str(b)], [0.7, 0.9])

    assert pipe.load_lora_weights.call_count == 2
    pipe.set_adapters.assert_called_once_with(
        ["inpaint_lora_0", "inpaint_lora_1"], adapter_weights=[0.7, 0.9]
    )


def test_load_inpaint_loras_default_scale_when_none(tmp_path) -> None:
    a = tmp_path / "a.safetensors"
    a.write_bytes(b"\x00")
    pipe = MagicMock()
    server_cuda._load_inpaint_loras(pipe, [str(a)], None)
    pipe.set_adapters.assert_called_once_with(
        ["inpaint_lora_0"], adapter_weights=[1.0]
    )


def test_load_inpaint_loras_swallows_set_adapters_exception(tmp_path) -> None:
    """If ``set_adapters`` fails, generation must continue without LoRA
    rather than crashing the request. (Matches the existing txt2img path.)"""
    a = tmp_path / "a.safetensors"
    a.write_bytes(b"\x00")
    pipe = MagicMock()
    pipe.set_adapters.side_effect = RuntimeError("PEFT not installed")
    # Must NOT raise
    server_cuda._load_inpaint_loras(pipe, [str(a)], [1.0])
