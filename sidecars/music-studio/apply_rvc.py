"""
RVC Voice Conversion — apply_rvc.py
Issue #386: Apply Retrieval-based Voice Conversion (RVC v2) to isolated vocals.

Uses a pre-trained RVC v2 model to convert the voice timbre of a vocal track
while preserving rhythm and melody.

Usage:
    python apply_rvc.py vocals.wav --voice-model artist_name --output converted.wav

Prerequisites:
    - RVC v2 model files: <models-dir>/<voice_model>/<voice_model>.pth + .index
    - fairseq, faiss-cpu, praat-parselmouth, pyworld, torchcrepe
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
logger = logging.getLogger("apply-rvc")

MODELS_DIR = os.environ.get(
    "RVC_MODELS_DIR",
    os.path.expanduser("~/.openzigs/rvc-models"),
)


def apply_rvc(
    input_path: str,
    output_path: str,
    voice_model: str,
    pitch_shift: int = 0,
    index_rate: float = 0.75,
    filter_radius: int = 3,
    rms_mix_rate: float = 0.25,
    protect: float = 0.33,
    f0_method: str = "rmvpe",
    device: str = "cpu",
) -> str:
    """
    Apply RVC v2 voice conversion to an input audio file.

    Returns the path to the converted audio file.
    """
    try:
        import torch
        import numpy as np
        import soundfile as sf
        import librosa
    except ImportError as e:
        logger.error(f"Missing dependency: {e}. Run: pip install -r requirements.txt")
        sys.exit(1)

    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    models_dir = Path(MODELS_DIR)
    model_dir = models_dir / voice_model

    # Find model and index files
    model_file = model_dir / f"{voice_model}.pth"
    index_file = model_dir / f"{voice_model}.index"

    if not model_file.exists():
        # Try to find any .pth file in the model directory
        pth_files = list(model_dir.glob("*.pth"))
        if not pth_files:
            raise FileNotFoundError(
                f"No RVC model found at {model_dir}. "
                f"Expected: {model_file}"
            )
        model_file = pth_files[0]
        logger.info(f"Using model file: {model_file}")

    if not index_file.exists():
        index_files = list(model_dir.glob("*.index"))
        index_file = index_files[0] if index_files else None
        if index_file:
            logger.info(f"Using index file: {index_file}")
        else:
            logger.warning("No .index file found — proceeding without feature index")

    logger.info(f"Loading RVC model: {model_file}")
    logger.info(f"Voice model: {voice_model}, pitch_shift: {pitch_shift}")

    # Load audio
    audio, sr = librosa.load(str(input_file), sr=16000, mono=True)
    logger.info(f"Input audio: {len(audio)/sr:.1f}s at {sr}Hz")

    # Load the RVC model
    from rvc_infer import load_model, run_inference

    model, config = load_model(str(model_file), device=device)

    # Run inference
    logger.info(f"Running RVC inference (f0_method={f0_method})...")
    converted_audio = run_inference(
        model=model,
        config=config,
        audio=audio,
        sr=sr,
        f0_method=f0_method,
        pitch_shift=pitch_shift,
        index_path=str(index_file) if index_file else None,
        index_rate=index_rate,
        filter_radius=filter_radius,
        rms_mix_rate=rms_mix_rate,
        protect=protect,
        device=device,
    )

    # Save output
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_file), converted_audio, sr)

    logger.info(f"Converted audio saved to: {output_file}")
    return str(output_file)


def main():
    parser = argparse.ArgumentParser(description="Apply RVC v2 voice conversion")
    parser.add_argument("input", help="Path to input vocals audio file")
    parser.add_argument("--output", "-o", default="./converted.wav", help="Output file path")
    parser.add_argument("--voice-model", "-m", required=True, help="RVC voice model name")
    parser.add_argument("--pitch-shift", type=int, default=0, help="Semitone pitch shift")
    parser.add_argument("--index-rate", type=float, default=0.75, help="Feature index rate (0-1)")
    parser.add_argument("--filter-radius", type=int, default=3, help="Median filter radius")
    parser.add_argument("--rms-mix-rate", type=float, default=0.25, help="RMS mix rate")
    parser.add_argument("--protect", type=float, default=0.33, help="Protect voiceless consonants")
    parser.add_argument("--f0-method", default="rmvpe", choices=["rmvpe", "crepe", "harvest", "pm"],
                        help="F0 pitch detection method")
    parser.add_argument("--device", default="cpu", choices=["cpu", "mps"], help="Device")
    args = parser.parse_args()

    result = apply_rvc(
        args.input,
        args.output,
        voice_model=args.voice_model,
        pitch_shift=args.pitch_shift,
        index_rate=args.index_rate,
        filter_radius=args.filter_radius,
        rms_mix_rate=args.rms_mix_rate,
        protect=args.protect,
        f0_method=args.f0_method,
        device=args.device,
    )
    print(f"Done: {result}")


if __name__ == "__main__":
    main()
