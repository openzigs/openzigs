"""
Track Analysis — htdemucs_6s + librosa key/BPM detection.

Issue #393: Split an uploaded track into 6 stems (vocals, drums, bass, guitar,
piano, other) using Meta Demucs htdemucs_6s, and extract BPM + musical key
with librosa.

Usage:
    python analyze_track.py input.wav --output-dir ./stems

Output JSON:
    {
        "stems": {"vocals": "...", "drums": "...", ...},
        "bpm": 120.0,
        "key": "C_minor"
    }
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("analyze-track")

# ── Key detection helpers ─────────────────────────────────────

# Krumhansl-Schmuckler key profiles for major and minor keys.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F",
               "F#", "G", "G#", "A", "A#", "B"]


def _detect_key(y, sr: int) -> str:
    """Detect musical key using chroma features + Krumhansl-Schmuckler.

    Parameters:
        y: Audio time-series array.
        sr (int): Sample rate.

    Returns:
        str: Detected key, e.g. 'C_minor' or 'G_major'.
    """
    import numpy as np
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = np.mean(chroma, axis=1)

    best_corr = -2.0
    best_key = "C_major"

    for shift in range(12):
        major_rotated = np.roll(MAJOR_PROFILE, shift)
        minor_rotated = np.roll(MINOR_PROFILE, shift)

        corr_maj = float(np.corrcoef(chroma_mean, major_rotated)[0, 1])
        corr_min = float(np.corrcoef(chroma_mean, minor_rotated)[0, 1])

        if corr_maj > best_corr:
            best_corr = corr_maj
            best_key = f"{PITCH_NAMES[shift]}_major"
        if corr_min > best_corr:
            best_corr = corr_min
            best_key = f"{PITCH_NAMES[shift]}_minor"

    return best_key


# ── 6-Stem separation ────────────────────────────────────────

STEM_NAMES_6S = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def analyze_track(
    input_path: str,
    output_dir: str,
    model_name: str = "htdemucs_6s",
    device: str = "cpu",
    shifts: int = 1,
    overlap: float = 0.25,
) -> dict:
    """Separate a track into 6 stems and analyze BPM + key.

    Parameters:
        input_path (str): Path to the input audio file.
        output_dir (str): Directory to write stem WAV files.
        model_name (str): Demucs model name (default htdemucs_6s).
        device (str): Compute device ('cpu' or 'mps').
        shifts (int): Random shifts for equivariant stabilization.
        overlap (float): Overlap between segments.

    Returns:
        dict: {"stems": {name: path, ...}, "bpm": float, "key": str}
    """
    try:
        import torch
        import torchaudio
    except ImportError:
        logger.error(
            "torch/torchaudio not installed. "
            "Run: pip install torch torchaudio"
        )
        sys.exit(1)

    try:
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError:
        logger.error(
            "demucs not installed. Run: pip install demucs"
        )
        sys.exit(1)

    try:
        import librosa
        import numpy as np
    except ImportError:
        logger.error(
            "librosa/numpy not installed. "
            "Run: pip install librosa numpy"
        )
        sys.exit(1)

    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # ── Step 1: BPM + Key analysis (on original mix) ──
    logger.info("Analyzing BPM and key...")
    y_librosa, sr_librosa = librosa.load(str(input_file), sr=22050, mono=True)

    tempo_arr = librosa.feature.tempo(y=y_librosa, sr=sr_librosa)
    bpm = float(tempo_arr[0]) if hasattr(tempo_arr, '__len__') else float(
        tempo_arr
    )

    key = _detect_key(y_librosa, sr_librosa)
    logger.info(f"Detected BPM={bpm:.1f}, Key={key}")

    # Free librosa arrays
    del y_librosa
    gc.collect()

    # ── Step 2: 6-stem separation with Demucs ──
    logger.info(f"Loading model {model_name} on {device}...")
    model = get_model(model_name)

    if device == "mps" and torch.backends.mps.is_available():
        model = model.to("mps")
    else:
        device = "cpu"
        model = model.to("cpu")

    logger.info(f"Loading audio: {input_file}")
    wav, sr = torchaudio.load(str(input_file))

    ref = wav.mean(0)
    wav_norm = (wav - ref.mean()) / ref.std()
    wav_norm = wav_norm.unsqueeze(0).to(device)

    logger.info(
        f"Separating into 6 stems "
        f"(shifts={shifts}, overlap={overlap})..."
    )
    with torch.no_grad():
        sources = apply_model(
            model,
            wav_norm,
            shifts=shifts,
            overlap=overlap,
            device=device,
        )

    # Map model source names to our canonical names
    source_names = list(model.sources)
    logger.info(f"Model sources: {source_names}")

    stems: dict[str, str] = {}
    for idx, name in enumerate(source_names):
        canonical = name if name in STEM_NAMES_6S else name
        stem_audio = sources[0, idx] * ref.std() + ref.mean()
        stem_path = str(out / f"{canonical}.wav")
        torchaudio.save(stem_path, stem_audio.cpu(), sr)
        stems[canonical] = stem_path
        logger.info(f"  Saved {canonical} → {stem_path}")

    # ── Cleanup ──
    del model, wav, wav_norm, sources, ref
    gc.collect()
    try:
        torch.mps.empty_cache()
    except Exception:
        pass

    result = {"stems": stems, "bpm": round(bpm, 1), "key": key}
    logger.info(f"Analysis complete: {json.dumps(result, indent=2)}")
    return result


def main():
    """CLI entry point for track analysis."""
    parser = argparse.ArgumentParser(
        description="Analyze track: 6-stem split + BPM/key detection"
    )
    parser.add_argument("input", help="Path to input audio file")
    parser.add_argument(
        "--output-dir", "-o", default="./stems",
        help="Output directory for stems"
    )
    parser.add_argument(
        "--model", default="htdemucs_6s",
        help="Demucs model name"
    )
    parser.add_argument(
        "--device", default="cpu",
        choices=["cpu", "mps"],
        help="Compute device"
    )
    parser.add_argument(
        "--shifts", type=int, default=1,
        help="Random shifts for equivariant stabilization"
    )
    parser.add_argument(
        "--overlap", type=float, default=0.25,
        help="Overlap between segments"
    )
    args = parser.parse_args()

    result = analyze_track(
        args.input,
        args.output_dir,
        model_name=args.model,
        device=args.device,
        shifts=args.shifts,
        overlap=args.overlap,
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
