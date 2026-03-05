"""
Seed-VC Voice Conversion — apply_seedvc.py
Issue #403: Zero-shot voice conversion using Seed-VC.

Converts the voice timbre of a vocal track to match a short reference audio clip
(1-30 seconds). No model training required — fully zero-shot.

Supports both speech and singing voice conversion:
  - Speech mode (f0_condition=False): 22.05 kHz, faster
  - Singing mode (f0_condition=True):  44.1 kHz, preserves pitch

Usage:
    python apply_seedvc.py vocals.wav --reference ref_voice.wav --output converted.wav

Prerequisites:
    - Seed-VC checkpoints auto-download from HuggingFace on first run
    - torch, torchaudio, librosa, transformers, pyyaml, munch, einops
"""

import argparse
import logging
import os
import sys
import subprocess
import tempfile
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("apply-seedvc")

SEED_VC_DIR = os.environ.get(
    "SEED_VC_DIR",
    os.path.expanduser("~/.openzigs/seed-vc"),
)

VOICE_REFS_DIR = os.environ.get(
    "VOICE_REFS_DIR",
    os.path.expanduser("~/.openzigs/voice-references"),
)


def ensure_seed_vc_installed() -> str:
    """Ensure Seed-VC repo is cloned and return its path."""
    seed_vc_path = Path(SEED_VC_DIR)
    if seed_vc_path.exists() and (seed_vc_path / "inference.py").exists():
        return str(seed_vc_path)

    logger.info(f"Seed-VC not found at {seed_vc_path}, cloning...")
    seed_vc_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "git", "clone", "--depth", "1",
            "https://github.com/Plachtaa/seed-vc.git",
            str(seed_vc_path),
        ],
        check=True,
        capture_output=True,
    )
    logger.info("Seed-VC cloned successfully")
    return str(seed_vc_path)


def apply_seedvc(
    input_path: str,
    output_path: str,
    reference_path: str,
    pitch_shift: int = 0,
    diffusion_steps: int = 30,
    length_adjust: float = 1.0,
    inference_cfg_rate: float = 0.7,
    f0_condition: bool = True,
    auto_f0_adjust: bool = True,
    device: str = "cpu",
) -> str:
    """
    Apply Seed-VC zero-shot voice conversion.

    Args:
        input_path: Path to input vocals audio file.
        output_path: Path to write converted audio.
        reference_path: Path to reference voice clip (1-30s).
        pitch_shift: Semitone pitch shift (-12 to +12).
        diffusion_steps: Number of diffusion steps (higher = better quality).
        length_adjust: Length adjustment ratio (1.0 = same length).
        inference_cfg_rate: Classifier-free guidance rate.
        f0_condition: True for singing VC (44.1kHz), False for speech VC (22kHz).
        auto_f0_adjust: Auto-adjust F0 based on reference voice.
        device: "cpu", "mps", or "cuda".

    Returns:
        Path to the converted audio file.
    """
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    ref_file = Path(reference_path)
    if not ref_file.exists():
        raise FileNotFoundError(f"Reference file not found: {reference_path}")

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    seed_vc_path = ensure_seed_vc_installed()

    logger.info(f"Running Seed-VC: input={input_path}, reference={reference_path}")
    logger.info(f"  f0_condition={f0_condition}, pitch_shift={pitch_shift}, "
                f"diffusion_steps={diffusion_steps}, device={device}")

    # Use a temp directory for Seed-VC output, then move the result
    with tempfile.TemporaryDirectory(prefix="seedvc-") as tmpdir:
        cmd = [
            sys.executable,
            os.path.join(seed_vc_path, "inference.py"),
            "--source", str(input_file),
            "--target", str(ref_file),
            "--output", tmpdir,
            "--diffusion-steps", str(diffusion_steps),
            "--length-adjust", str(length_adjust),
            "--inference-cfg-rate", str(inference_cfg_rate),
            "--f0-condition", str(f0_condition),
            "--auto-f0-adjust", str(auto_f0_adjust),
            "--semi-tone-shift", str(pitch_shift),
            "--fp16", "True" if device != "cpu" else "False",
        ]

        env = os.environ.copy()
        env["HF_HUB_CACHE"] = os.path.join(seed_vc_path, "checkpoints", "hf_cache")

        logger.info(f"Executing: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            cwd=seed_vc_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=600,
        )

        if result.returncode != 0:
            logger.error(f"Seed-VC stderr: {result.stderr}")
            raise RuntimeError(
                f"Seed-VC inference failed (exit {result.returncode}): "
                f"{result.stderr[:500]}"
            )

        if result.stdout:
            logger.info(f"Seed-VC stdout: {result.stdout[:300]}")

        # Find the output file (seed-vc names it vc_<source>_<target>_*.wav)
        tmp_path = Path(tmpdir)
        wav_files = list(tmp_path.glob("vc_*.wav"))
        if not wav_files:
            # Fallback: look for any .wav file
            wav_files = list(tmp_path.glob("*.wav"))

        if not wav_files:
            raise FileNotFoundError(
                f"No output WAV found in {tmpdir}. "
                f"Seed-VC may have failed silently."
            )

        # Move the first result to the output path
        import shutil
        shutil.move(str(wav_files[0]), str(output_file))

    logger.info(f"Converted audio saved to: {output_file}")
    return str(output_file)


def main():
    parser = argparse.ArgumentParser(
        description="Apply Seed-VC zero-shot voice conversion"
    )
    parser.add_argument("input", help="Path to input vocals audio file")
    parser.add_argument(
        "--reference", "-r", required=True,
        help="Path to reference voice clip (1-30s WAV/MP3)"
    )
    parser.add_argument(
        "--output", "-o", default="./converted.wav",
        help="Output file path"
    )
    parser.add_argument(
        "--pitch-shift", type=int, default=0,
        help="Semitone pitch shift (-12 to +12)"
    )
    parser.add_argument(
        "--diffusion-steps", type=int, default=30,
        help="Diffusion steps (higher = better quality, slower)"
    )
    parser.add_argument(
        "--length-adjust", type=float, default=1.0,
        help="Length adjustment ratio"
    )
    parser.add_argument(
        "--inference-cfg-rate", type=float, default=0.7,
        help="Classifier-free guidance rate"
    )
    parser.add_argument(
        "--singing", action="store_true", default=True,
        help="Enable singing VC mode (f0-conditioned, 44.1kHz)"
    )
    parser.add_argument(
        "--speech", action="store_true",
        help="Use speech VC mode (no F0, 22kHz)"
    )
    parser.add_argument(
        "--device", default="cpu",
        choices=["cpu", "mps", "cuda"],
        help="Compute device"
    )
    args = parser.parse_args()

    f0_condition = not args.speech

    apply_seedvc(
        args.input,
        args.output,
        reference_path=args.reference,
        pitch_shift=args.pitch_shift,
        diffusion_steps=args.diffusion_steps,
        length_adjust=args.length_adjust,
        inference_cfg_rate=args.inference_cfg_rate,
        f0_condition=f0_condition,
        device=args.device,
    )


if __name__ == "__main__":
    main()
