"""
Stem Separation — Demucs v4
Issue #385: Extract vocals and instrumental stems from a source audio file.

Uses Meta's Demucs v4 (htdemucs_ft model) for high-quality stem separation
on Apple Silicon via CPU/MPS.

Usage:
    python extract_vocals.py input.wav --output-dir ./stems

Output:
    <output-dir>/vocals.wav
    <output-dir>/no_vocals.wav   (drums + bass + other summed)
"""

import argparse
import logging
import os
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("extract-vocals")


def extract_vocals(
    input_path: str,
    output_dir: str,
    model_name: str = "htdemucs_ft",
    device: str = "cpu",
    shifts: int = 1,
    overlap: float = 0.25,
) -> dict:
    """
    Separate vocals from instrumentals using Demucs v4.

    Returns dict with paths: {"vocals": ..., "no_vocals": ...}
    """
    try:
        import torch
        import torchaudio
    except ImportError:
        logger.error("torch/torchaudio not installed. Run: pip install torch torchaudio")
        sys.exit(1)

    try:
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError:
        logger.error("demucs not installed. Run: pip install demucs")
        sys.exit(1)

    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    logger.info(f"Loading model {model_name} on {device}...")
    model = get_model(model_name)

    if device == "mps" and torch.backends.mps.is_available():
        model = model.to("mps")
    else:
        device = "cpu"
        model = model.to("cpu")

    logger.info(f"Loading audio: {input_file}")
    wav, sr = torchaudio.load(str(input_file))

    # Demucs expects (batch, channels, samples)
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    wav = wav.unsqueeze(0).to(device)

    logger.info(f"Separating stems (shifts={shifts}, overlap={overlap})...")
    with torch.no_grad():
        sources = apply_model(
            model,
            wav,
            shifts=shifts,
            overlap=overlap,
            device=device,
        )

    # sources shape: (batch, n_sources, channels, samples)
    # htdemucs_ft sources: drums, bass, other, vocals
    source_names = model.sources
    vocals_idx = source_names.index("vocals")

    vocals = sources[0, vocals_idx]
    # Sum all non-vocal stems for the instrumental track
    non_vocal_indices = [i for i in range(len(source_names)) if i != vocals_idx]
    no_vocals = sum(sources[0, i] for i in non_vocal_indices)

    # De-normalize
    vocals = vocals * ref.std() + ref.mean()
    no_vocals = no_vocals * ref.std() + ref.mean()

    vocals_path = str(out / "vocals.wav")
    no_vocals_path = str(out / "no_vocals.wav")

    torchaudio.save(vocals_path, vocals.cpu(), sr)
    torchaudio.save(no_vocals_path, no_vocals.cpu(), sr)

    logger.info(f"Vocals saved to: {vocals_path}")
    logger.info(f"Instrumental saved to: {no_vocals_path}")

    return {"vocals": vocals_path, "no_vocals": no_vocals_path}


def main():
    parser = argparse.ArgumentParser(description="Extract vocals using Demucs v4")
    parser.add_argument("input", help="Path to input audio file")
    parser.add_argument("--output-dir", "-o", default="./stems", help="Output directory")
    parser.add_argument("--model", default="htdemucs_ft", help="Demucs model name")
    parser.add_argument("--device", default="cpu", choices=["cpu", "mps"], help="Device")
    parser.add_argument("--shifts", type=int, default=1, help="Random shifts for equivariant stabilization")
    parser.add_argument("--overlap", type=float, default=0.25, help="Overlap between segments")
    args = parser.parse_args()

    result = extract_vocals(
        args.input,
        args.output_dir,
        model_name=args.model,
        device=args.device,
        shifts=args.shifts,
        overlap=args.overlap,
    )
    print(f"Done: {result}")


if __name__ == "__main__":
    main()
