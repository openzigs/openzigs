"""
Auto-Mastering — matchering-based EQ balancing + LUFS normalization.

Issue #393: Take the mixed track from smart_mix.py and automatically
balance EQ against a reference profile, bringing overall LUFS up to
professional streaming standards.

Usage:
    python finalize.py mixed.wav --output remixed_master.wav

Dependencies:
    pip install matchering soundfile numpy
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
logger = logging.getLogger("finalize")

# ── Reference profiles ───────────────────────────────────────
# Directory where reference master tracks are stored.
# Users can place reference WAV files for each vibe.
REFERENCE_DIR = os.environ.get(
    "REFERENCE_DIR",
    os.path.expanduser("~/.openzigs/remix-references"),
)

# Default reference files per vibe (optional — if missing, uses
# LUFS normalization only without matchering).
VIBE_REFERENCES: dict[str, str] = {
    "punchy_pop": "reference_pop.wav",
    "warm_lofi": "reference_lofi.wav",
    "cinematic_wide": "reference_cinematic.wav",
    "raw": "reference_raw.wav",
}


def _normalize_lufs(
    input_path: str,
    output_path: str,
    target_lufs: float = -14.0,
) -> str:
    """Normalize audio to a target LUFS level using ITU-R BS.1770 measurement.

    Parameters:
        input_path (str): Path to the input WAV file.
        output_path (str): Output path for the normalized WAV.
        target_lufs (float): Target integrated LUFS.

    Returns:
        str: Path to the normalized WAV file.
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

    data, sr = sf.read(input_path, dtype="float32")

    # Use pyloudnorm for accurate ITU-R BS.1770 LUFS measurement
    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(sr)  # ITU-R BS.1770
        # pyloudnorm expects shape (samples, channels)
        if data.ndim == 1:
            mono_data = data.reshape(-1, 1)
            current_lufs = meter.integrated_loudness(np.column_stack([mono_data, mono_data]))
        else:
            current_lufs = meter.integrated_loudness(data)

        if np.isinf(current_lufs) or np.isnan(current_lufs):
            logger.warning("Audio is silent — skipping normalization")
            sf.write(output_path, data, sr)
            return output_path

        gain_db = target_lufs - current_lufs
        gain_linear = 10 ** (gain_db / 20)

        logger.info(
            f"LUFS normalization (BS.1770): {current_lufs:.1f} → "
            f"{target_lufs:.1f} dB (gain={gain_db:+.1f} dB)"
        )

        data = data * gain_linear

    except ImportError:
        logger.warning(
            "pyloudnorm not installed — using RMS approximation. "
            "Run: pip install pyloudnorm"
        )
        # Fallback to RMS approximation
        rms = float(np.sqrt(np.mean(data ** 2)))
        if rms <= 0:
            logger.warning("Audio is silent — skipping normalization")
            sf.write(output_path, data, sr)
            return output_path

        current_lufs = 20 * np.log10(rms) - 0.691
        gain_db = target_lufs - current_lufs
        gain_linear = 10 ** (gain_db / 20)

        logger.info(
            f"LUFS normalization (RMS fallback): {current_lufs:.1f} → "
            f"{target_lufs:.1f} dB (gain={gain_db:+.1f} dB)"
        )

        data = data * gain_linear

    # Brick-wall limiter to prevent clipping
    peak = float(np.max(np.abs(data)))
    if peak > 0.99:
        # Apply hard clip ceiling at 0.99 FS to prevent clipping
        ceiling = 0.99
        data = np.where(
            np.abs(data) > ceiling,
            np.sign(data) * ceiling,
            data,
        )

    sf.write(output_path, data, sr)
    del data
    gc.collect()

    return output_path


def finalize(
    input_path: str,
    output_path: str,
    vibe: Optional[str] = None,
    target_lufs: float = -14.0,
) -> str:
    """Auto-master a mixed track using matchering (if reference available).

    Performs EQ matching against a reference profile and normalizes
    loudness to streaming standards (-14 LUFS for Spotify/YouTube).

    Parameters:
        input_path (str): Path to the mixed WAV from smart_mix.py.
        output_path (str): Output path for the mastered WAV.
        vibe (str, optional): Vibe preset used during mixing, to
            select the matching reference file.
        target_lufs (float): Target LUFS level (default -14.0).

    Returns:
        str: Path to the final mastered WAV file.
    """
    if not os.path.isfile(input_path):
        raise FileNotFoundError(
            f"Mixed track not found: {input_path}"
        )

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    # Try to find a reference file for matchering
    reference_path = None
    if vibe and vibe in VIBE_REFERENCES:
        candidate = os.path.join(
            REFERENCE_DIR, VIBE_REFERENCES[vibe]
        )
        if os.path.isfile(candidate):
            reference_path = candidate
            logger.info(
                f"Using matchering reference: "
                f"{os.path.basename(candidate)}"
            )

    if reference_path:
        # Use matchering for professional auto-mastering
        try:
            import matchering as mg

            mg.log(logger.info)

            mg.process(
                target=input_path,
                reference=reference_path,
                results=[mg.pcm16(output_path)],
            )

            logger.info(
                f"Matchering complete: {output_path}"
            )

            gc.collect()
            return output_path

        except ImportError:
            logger.warning(
                "matchering not installed — falling back to "
                "LUFS normalization. "
                "Run: pip install matchering"
            )
        except Exception as e:
            logger.warning(
                f"matchering failed ({e}) — falling back to "
                f"LUFS normalization"
            )

    # Fallback: simple LUFS normalization
    logger.info("Using LUFS normalization (no reference file)")
    return _normalize_lufs(input_path, output_path, target_lufs)


def main():
    """CLI entry point for auto-mastering."""
    parser = argparse.ArgumentParser(
        description=(
            "Auto-master a mixed track with matchering or "
            "LUFS normalization"
        )
    )
    parser.add_argument(
        "input", help="Path to the mixed WAV file"
    )
    parser.add_argument(
        "--output", "-o", default="remixed_master.wav",
        help="Output path for the mastered file"
    )
    parser.add_argument(
        "--vibe", default=None,
        help="Vibe preset to select reference file"
    )
    parser.add_argument(
        "--target-lufs", type=float, default=-14.0,
        help="Target LUFS level (default: -14.0)"
    )
    args = parser.parse_args()

    finalize(
        args.input,
        args.output,
        vibe=args.vibe,
        target_lufs=args.target_lufs,
    )


if __name__ == "__main__":
    main()
