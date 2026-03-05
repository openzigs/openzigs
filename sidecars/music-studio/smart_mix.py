"""
Smart Mix — Vibe-based DSP mixing engine.

Issue #393: Mix separated stems together with user volume levels and apply
a "Vibe" preset DSP chain using Spotify pedalboard + pydub.

Vibe Presets:
    - Punchy Pop: Hard compression on drums/bass, bright EQ
    - Warm Lo-Fi: Low-pass filter + tape saturation
    - Cinematic & Wide: Stereo widening + reverb tail
    - Raw: No processing, clean mix only

Usage:
    python smart_mix.py \\
        --stems vocals=stems/vocals.wav drums=stems/drums.wav ... \\
        --volumes vocals=0.8 drums=1.0 ... \\
        --vibe "warm_lofi" \\
        --output mixed.wav

Dependencies:
    pip install pedalboard pydub numpy soundfile
"""

from __future__ import annotations

import argparse
import gc
import logging
import os
import sys
from pathlib import Path
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("smart-mix")

# ── Vibe Presets ─────────────────────────────────────────────

VIBE_PRESETS = {
    "punchy_pop": {
        "label": "Punchy Pop",
        "description": (
            "Aggressive compression on drums and bass, "
            "bright presence boost"
        ),
    },
    "warm_lofi": {
        "label": "Warm Lo-Fi",
        "description": (
            "Low-pass filter on master, subtle tape saturation"
        ),
    },
    "cinematic_wide": {
        "label": "Cinematic & Wide",
        "description": (
            "Stereo widening, lush reverb, "
            "dynamic range preservation"
        ),
    },
    "raw": {
        "label": "Raw",
        "description": "No processing — clean volume-only mix",
    },
}


def _apply_punchy_pop(
    stem_name: str,
    audio,
    sample_rate: int,
):
    """Apply Punchy Pop processing to a stem.

    Parameters:
        stem_name (str): Name of the stem (e.g. 'drums', 'bass').
        audio: numpy array of audio data.
        sample_rate (int): Sample rate.

    Returns:
        Processed audio numpy array.
    """
    from pedalboard import (
        Compressor, Gain, HighShelfFilter, Limiter,
    )

    if stem_name in ("drums", "bass"):
        comp = Compressor(
            threshold_db=-18, ratio=6, attack_ms=2.0,
            release_ms=50,
        )
        gain = Gain(gain_db=3)
        audio = comp(audio, sample_rate)
        audio = gain(audio, sample_rate, reset=False)

    if stem_name == "vocals":
        bright = HighShelfFilter(
            cutoff_frequency_hz=4000, gain_db=2.5,
        )
        audio = bright(audio, sample_rate, reset=False)

    return audio


def _apply_warm_lofi(
    stem_name: str,
    audio,
    sample_rate: int,
):
    """Apply Warm Lo-Fi processing to a stem.

    Parameters:
        stem_name (str): Name of the stem.
        audio: numpy array of audio data.
        sample_rate (int): Sample rate.

    Returns:
        Processed audio numpy array.
    """
    from pedalboard import (
        LowpassFilter, Gain, Distortion,
    )

    # Gentle low-pass to remove harsh highs
    lpf = LowpassFilter(cutoff_frequency_hz=8000)
    audio = lpf(audio, sample_rate)

    # Subtle saturation for warmth
    if stem_name != "vocals":
        sat = Distortion(drive_db=3.0)
        audio = sat(audio, sample_rate, reset=False)

    return audio


def _apply_cinematic_wide(
    stem_name: str,
    audio,
    sample_rate: int,
):
    """Apply Cinematic & Wide processing to a stem.

    Parameters:
        stem_name (str): Name of the stem.
        audio: numpy array of audio data.
        sample_rate (int): Sample rate.

    Returns:
        Processed audio numpy array.
    """
    from pedalboard import Reverb, Chorus, Delay

    # Lush reverb on everything except drums
    if stem_name != "drums":
        reverb = Reverb(
            room_size=0.7, damping=0.5, wet_level=0.2,
            dry_level=0.8, width=1.0,
        )
        audio = reverb(audio, sample_rate)

    # Gentle chorus for width on pads/strings/piano
    if stem_name in ("piano", "guitar", "other"):
        chorus = Chorus(
            rate_hz=0.8, depth=0.15, mix=0.25,
        )
        audio = chorus(audio, sample_rate, reset=False)

    return audio


def smart_mix(
    stem_paths: dict[str, str],
    volumes: dict[str, float],
    muted: dict[str, bool],
    vibe: str,
    output_path: str,
    sample_rate: int = 44100,
) -> str:
    """Mix stems with volume levels and a Vibe DSP preset.

    Parameters:
        stem_paths (dict): Mapping stem name → WAV file path.
        volumes (dict): Mapping stem name → volume float (0.0–2.0).
        muted (dict): Mapping stem name → muted boolean.
        vibe (str): Vibe preset key from VIBE_PRESETS.
        output_path (str): Output WAV path.
        sample_rate (int): Target sample rate.

    Returns:
        str: Path to the mixed WAV file.
    """
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        logger.error(
            "numpy/soundfile not installed. "
            "Run: pip install numpy soundfile"
        )
        sys.exit(1)

    if vibe not in VIBE_PRESETS:
        available = ", ".join(sorted(VIBE_PRESETS.keys()))
        raise ValueError(
            f"Unknown vibe '{vibe}'. Available: {available}"
        )

    logger.info(
        f"Mixing {len(stem_paths)} stems with vibe "
        f"'{VIBE_PRESETS[vibe]['label']}'"
    )

    mixed = None
    max_length = 0
    stem_count = 0

    # First pass: determine max length and count active stems
    for name, path in stem_paths.items():
        if muted.get(name, False):
            continue
        data, sr = sf.read(path, dtype="float32")
        if data.ndim == 1:
            data = data.reshape(-1, 1)
        max_length = max(max_length, data.shape[0])
        stem_count += 1

    if max_length == 0:
        raise ValueError("All stems are muted — nothing to mix")

    mixed = np.zeros((max_length, 2), dtype=np.float32)

    # Gain staging: apply headroom reduction per stem to prevent summing clipping.
    # With N stems each at unity, naive summing can reach N× peak.
    # We use a conservative headroom factor: -3 dB per doubling of stems.
    if stem_count > 1:
        headroom_db = -3.0 * np.log2(stem_count)
        headroom_linear = float(10 ** (headroom_db / 20))
    else:
        headroom_linear = 1.0

    logger.info(
        f"Gain staging: {stem_count} stems, "
        f"headroom={20 * np.log10(headroom_linear):.1f} dB"
    )

    # Second pass: process each stem and accumulate
    for name, path in stem_paths.items():
        if muted.get(name, False):
            logger.info(f"  Skipping muted stem: {name}")
            continue

        vol = volumes.get(name, 1.0)
        logger.info(f"  Processing {name} (vol={vol:.2f})...")

        data, sr = sf.read(path, dtype="float32")
        if data.ndim == 1:
            data = data.reshape(-1, 1)

        # Resample if needed
        if sr != sample_rate:
            try:
                import librosa
                if data.ndim == 2 and data.shape[1] == 2:
                    left = librosa.resample(
                        data[:, 0], orig_sr=sr,
                        target_sr=sample_rate,
                    )
                    right = librosa.resample(
                        data[:, 1], orig_sr=sr,
                        target_sr=sample_rate,
                    )
                    data = np.stack([left, right], axis=1)
                else:
                    data = librosa.resample(
                        data.flatten(), orig_sr=sr,
                        target_sr=sample_rate,
                    ).reshape(-1, 1)
            except ImportError:
                logger.warning(
                    f"librosa not available for resampling "
                    f"{name} ({sr}→{sample_rate})"
                )

        # Ensure stereo
        if data.shape[1] == 1:
            data = np.concatenate([data, data], axis=1)

        # Apply volume with headroom
        data = data * vol * headroom_linear

        # Apply vibe processing
        if vibe == "punchy_pop":
            data = _apply_punchy_pop(name, data, sample_rate)
        elif vibe == "warm_lofi":
            data = _apply_warm_lofi(name, data, sample_rate)
        elif vibe == "cinematic_wide":
            data = _apply_cinematic_wide(name, data, sample_rate)
        # 'raw' = no processing

        # Pad to max_length if shorter
        pad_len = max_length - data.shape[0]
        if pad_len > 0:
            data = np.pad(data, ((0, pad_len), (0, 0)))

        # Truncate if somehow longer
        mixed += data[:max_length]

        del data
        gc.collect()

    # Normalize to prevent clipping
    peak = np.max(np.abs(mixed))
    if peak > 0.95:
        mixed = mixed / peak * 0.95

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    sf.write(output_path, mixed, sample_rate)
    logger.info(f"Mix complete: {output_path}")

    del mixed
    gc.collect()

    return output_path


def main():
    """CLI entry point for smart mix."""
    parser = argparse.ArgumentParser(
        description="Mix stems with Vibe DSP presets"
    )
    parser.add_argument(
        "--stems", nargs="+", required=True,
        help="Stem assignments: name=path (e.g. vocals=stems/vocals.wav)"
    )
    parser.add_argument(
        "--volumes", nargs="+", default=[],
        help="Volume levels: name=float (e.g. vocals=0.8)"
    )
    parser.add_argument(
        "--vibe", default="raw",
        choices=list(VIBE_PRESETS.keys()),
        help="Vibe preset"
    )
    parser.add_argument(
        "--output", "-o", default="mixed.wav",
        help="Output WAV path"
    )
    args = parser.parse_args()

    stem_paths = {}
    for s in args.stems:
        name, path = s.split("=", 1)
        stem_paths[name] = path

    volumes: dict[str, float] = {}
    for v in args.volumes:
        name, val = v.split("=", 1)
        volumes[name] = float(val)

    smart_mix(
        stem_paths=stem_paths,
        volumes=volumes,
        muted={},
        vibe=args.vibe,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
