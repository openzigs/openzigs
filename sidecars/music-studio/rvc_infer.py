"""
RVC Inference Helper
Wraps RVC v2 model loading and inference in a clean API.

This module is imported by apply_rvc.py and the FastAPI sidecar.
It abstracts the RVC pipeline details so callers just pass audio arrays.
"""

import logging
import numpy as np
from pathlib import Path

logger = logging.getLogger("rvc-infer")


def load_model(model_path: str, device: str = "cpu"):
    """
    Load an RVC v2 model from a .pth checkpoint.

    Returns (model, config) tuple.
    """
    import torch

    logger.info(f"Loading RVC model from {model_path} on {device}")
    checkpoint = torch.load(model_path, map_location=device, weights_only=False)

    config = checkpoint.get("config", {})
    if isinstance(config, (list, tuple)):
        # Some RVC checkpoints store config as a list
        config = {"sr": 40000, "channels": 1}

    model_data = checkpoint.get("model", checkpoint.get("weight", {}))
    logger.info(f"Model loaded: sr={config.get('sr', 'unknown')}")

    return model_data, config


def run_inference(
    model,
    config,
    audio: np.ndarray,
    sr: int = 16000,
    f0_method: str = "rmvpe",
    pitch_shift: int = 0,
    index_path: str | None = None,
    index_rate: float = 0.75,
    filter_radius: int = 3,
    rms_mix_rate: float = 0.25,
    protect: float = 0.33,
    device: str = "cpu",
) -> np.ndarray:
    """
    Run RVC v2 inference on audio data.

    This is a simplified pipeline that:
    1. Extracts F0 (pitch) from the input
    2. Shifts pitch by the specified semitones
    3. Runs the voice conversion model
    4. Returns the converted audio as a numpy array

    For production use, this should integrate with a full RVC pipeline
    (e.g. rvc-python or Applio). This implementation provides the interface
    contract that the sidecar expects.
    """
    import torch

    logger.info(
        f"RVC inference: f0={f0_method}, pitch={pitch_shift:+d}, "
        f"index_rate={index_rate}, filter={filter_radius}"
    )

    # Ensure audio is float32 mono
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)

    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)

    # Extract F0 using the specified method
    f0 = _extract_f0(audio, sr, f0_method)

    # Apply pitch shift (semitones → frequency multiplier)
    if pitch_shift != 0:
        f0 = f0 * (2 ** (pitch_shift / 12.0))

    # Apply median filter to smooth F0
    if filter_radius > 0:
        f0 = _median_filter(f0, filter_radius)

    # Run the conversion model
    # NOTE: Full RVC pipeline integration goes here.
    # This placeholder returns pitch-shifted audio using basic resampling.
    # The actual sidecar should use rvc-python or equivalent.
    converted = _basic_pitch_shift(audio, sr, pitch_shift)

    # RMS mix: blend converted volume with original
    if rms_mix_rate > 0:
        rms_orig = np.sqrt(np.mean(audio ** 2)) + 1e-7
        rms_conv = np.sqrt(np.mean(converted ** 2)) + 1e-7
        converted = converted * (rms_mix_rate * rms_orig / rms_conv + (1 - rms_mix_rate))

    return converted


def _extract_f0(audio: np.ndarray, sr: int, method: str) -> np.ndarray:
    """Extract fundamental frequency contour."""
    hop_length = 160  # 10ms at 16kHz
    n_frames = len(audio) // hop_length

    if method == "rmvpe":
        try:
            import torchcrepe
            import torch
            # Use crepe as a fallback for rmvpe
            audio_tensor = torch.from_numpy(audio).unsqueeze(0).float()
            f0_tensor = torchcrepe.predict(
                audio_tensor, sr, hop_length,
                fmin=50, fmax=1100,
                model="tiny", device="cpu",
                batch_size=512,
            )
            return f0_tensor.squeeze().numpy()
        except ImportError:
            pass

    # Fallback: simple autocorrelation F0 detection
    f0 = np.zeros(n_frames)
    for i in range(n_frames):
        start = i * hop_length
        end = min(start + hop_length * 4, len(audio))
        frame = audio[start:end]
        if len(frame) < hop_length * 2:
            continue
        # Simple autocorrelation
        corr = np.correlate(frame, frame, mode="full")
        corr = corr[len(corr) // 2:]
        # Find first peak after zero crossing
        min_period = sr // 1100  # Max frequency
        max_period = sr // 50    # Min frequency
        if max_period < len(corr):
            segment = corr[min_period:max_period]
            if len(segment) > 0:
                peak = np.argmax(segment) + min_period
                if peak > 0:
                    f0[i] = sr / peak

    return f0


def _median_filter(data: np.ndarray, radius: int) -> np.ndarray:
    """Apply median filter to 1D array."""
    from scipy.ndimage import median_filter as scipy_median
    return scipy_median(data, size=2 * radius + 1)


def _basic_pitch_shift(audio: np.ndarray, sr: int, semitones: int) -> np.ndarray:
    """Basic pitch shift via resampling (placeholder for full RVC model)."""
    if semitones == 0:
        return audio.copy()

    try:
        import librosa
        return librosa.effects.pitch_shift(y=audio, sr=sr, n_steps=semitones)
    except ImportError:
        # Fallback: simple resampling (changes duration)
        ratio = 2 ** (semitones / 12.0)
        indices = np.arange(0, len(audio), ratio)
        indices = indices[indices < len(audio)].astype(int)
        return audio[indices]
