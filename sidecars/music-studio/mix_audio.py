"""
Final Mixdown — mix_audio.py
Issue #387: Mix converted vocals back with instrumental stem using pydub.

Combines the RVC-converted vocal track with the instrumental stem,
applying volume adjustments and optional normalization.

Usage:
    python mix_audio.py converted_vocals.wav instrumental.wav --output final_mix.wav

Prerequisites:
    - pydub (pip install pydub)
    - ffmpeg (brew install ffmpeg)
"""

import argparse
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("mix-audio")


def mix_audio(
    vocals_path: str,
    instrumental_path: str,
    output_path: str,
    vocal_volume: float = 1.0,
    instrumental_volume: float = 1.0,
    output_format: str = "wav",
    normalize: bool = True,
    target_lufs: float = -14.0,
) -> str:
    """
    Mix converted vocals with instrumental stem.

    Args:
        vocals_path: Path to the converted vocal track
        instrumental_path: Path to the instrumental track
        output_path: Path for the final mixed output
        vocal_volume: Volume multiplier for vocals (1.0 = unchanged)
        instrumental_volume: Volume multiplier for instrumentals (1.0 = unchanged)
        output_format: Output format (wav, mp3)
        normalize: Whether to normalize the final mix
        target_lufs: Target loudness in LUFS for normalization

    Returns the path to the mixed output file.
    """
    try:
        from pydub import AudioSegment
    except ImportError:
        raise ImportError("pydub not installed. Run: pip install pydub")

    vocals_file = Path(vocals_path)
    instrumental_file = Path(instrumental_path)

    if not vocals_file.exists():
        raise FileNotFoundError(f"Vocals file not found: {vocals_path}")
    if not instrumental_file.exists():
        raise FileNotFoundError(f"Instrumental file not found: {instrumental_path}")

    logger.info(f"Loading vocals: {vocals_path}")
    vocals = AudioSegment.from_file(str(vocals_file))

    logger.info(f"Loading instrumental: {instrumental_path}")
    instrumental = AudioSegment.from_file(str(instrumental_file))

    # Apply volume adjustments (convert multiplier to dB)
    if vocal_volume != 1.0:
        import math
        vocal_db = 20 * math.log10(max(vocal_volume, 0.001))
        vocals = vocals + vocal_db
        logger.info(f"Vocal volume adjusted: {vocal_db:+.1f} dB")

    if instrumental_volume != 1.0:
        import math
        instrumental_db = 20 * math.log10(max(instrumental_volume, 0.001))
        instrumental = instrumental + instrumental_db
        logger.info(f"Instrumental volume adjusted: {instrumental_db:+.1f} dB")

    # Ensure both tracks have the same sample rate and channels
    if vocals.frame_rate != instrumental.frame_rate:
        logger.info(f"Resampling instrumental from {instrumental.frame_rate}Hz to {vocals.frame_rate}Hz")
        instrumental = instrumental.set_frame_rate(vocals.frame_rate)

    if vocals.channels != instrumental.channels:
        if vocals.channels == 1:
            vocals = vocals.set_channels(2)
        if instrumental.channels == 1:
            instrumental = instrumental.set_channels(2)

    # Pad shorter track with silence to match the longer one
    len_diff = len(vocals) - len(instrumental)
    if len_diff > 0:
        instrumental = instrumental + AudioSegment.silent(duration=len_diff, frame_rate=instrumental.frame_rate)
    elif len_diff < 0:
        vocals = vocals + AudioSegment.silent(duration=abs(len_diff), frame_rate=vocals.frame_rate)

    # Overlay vocals onto instrumental
    logger.info("Mixing tracks...")
    mixed = instrumental.overlay(vocals)

    # Simple peak normalization
    if normalize:
        headroom = mixed.max_dBFS
        if headroom < 0:
            # Normalize to -1 dBFS peak
            mixed = mixed + (-1.0 - headroom)
            logger.info(f"Normalized: +{-1.0 - headroom:.1f} dB (peak at -1.0 dBFS)")

    # Export
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    export_params = {}
    if output_format == "mp3":
        export_params["bitrate"] = "320k"

    mixed.export(str(output_file), format=output_format, **export_params)

    duration_s = len(mixed) / 1000.0
    logger.info(f"Final mix saved: {output_file} ({duration_s:.1f}s, {output_format})")
    return str(output_file)


def main():
    parser = argparse.ArgumentParser(description="Mix converted vocals with instrumental")
    parser.add_argument("vocals", help="Path to converted vocal track")
    parser.add_argument("instrumental", help="Path to instrumental track")
    parser.add_argument("--output", "-o", default="./final_mix.wav", help="Output file path")
    parser.add_argument("--vocal-volume", type=float, default=1.0, help="Vocal volume multiplier")
    parser.add_argument("--instrumental-volume", type=float, default=1.0, help="Instrumental volume multiplier")
    parser.add_argument("--format", dest="output_format", default="wav", choices=["wav", "mp3"],
                        help="Output format")
    parser.add_argument("--no-normalize", action="store_true", help="Skip normalization")
    args = parser.parse_args()

    result = mix_audio(
        args.vocals,
        args.instrumental,
        args.output,
        vocal_volume=args.vocal_volume,
        instrumental_volume=args.instrumental_volume,
        output_format=args.output_format,
        normalize=not args.no_normalize,
    )
    print(f"Done: {result}")


if __name__ == "__main__":
    main()
