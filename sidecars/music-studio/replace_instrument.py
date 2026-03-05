"""
Melody Preservation Engine — Audio-to-MIDI transcription + SoundFont synthesis.

Issue #393: Replace an instrument stem while preserving the original melody:
    1. Decode notes from the source stem using basic-pitch (Spotify).
    2. Synthesize the MIDI with a new instrument via pyfluidsynth + .sf2.
    3. Post-process with pedalboard (Reverb, Chorus) to avoid a dry sound.

Usage:
    python replace_instrument.py source_guitar.wav \\
        --instrument 80s_analog_synth \\
        --bpm 120 --key C_minor \\
        --output replaced_stem.wav

Dependencies:
    pip install basic-pitch pyfluidsynth pedalboard mido numpy soundfile
"""

from __future__ import annotations

import argparse
import gc
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("replace-instrument")

# ── SoundFont Mapping ────────────────────────────────────────
# Maps target_instrument_id → relative path under SOUNDFONT_DIR.
# Users place .sf2 files in ~/.openzigs/soundfonts/.

SOUNDFONT_DIR = os.environ.get(
    "SOUNDFONT_DIR",
    os.path.expanduser("~/.openzigs/soundfonts"),
)

SOUNDFONT_MAP: dict[str, str] = {
    "80s_analog_synth": "synth_80s.sf2",
    "slap_bass": "slap_bass.sf2",
    "grand_piano": "grand_piano.sf2",
    "electric_guitar": "electric_guitar.sf2",
    "acoustic_guitar": "acoustic_guitar.sf2",
    "strings_ensemble": "strings_ensemble.sf2",
    "brass_section": "brass_section.sf2",
    "flute": "flute.sf2",
    "organ": "organ.sf2",
    "marimba": "marimba.sf2",
}


def get_soundfont_path(instrument_id: str) -> str:
    """Resolve the absolute path to a .sf2 SoundFont file.

    Parameters:
        instrument_id (str): Key from SOUNDFONT_MAP.

    Returns:
        str: Absolute path to the .sf2 file.

    Raises:
        ValueError: If the instrument_id is unknown.
        FileNotFoundError: If the .sf2 file doesn't exist on disk.
    """
    if instrument_id not in SOUNDFONT_MAP:
        available = ", ".join(sorted(SOUNDFONT_MAP.keys()))
        raise ValueError(
            f"Unknown instrument '{instrument_id}'. "
            f"Available: {available}"
        )

    sf2_path = os.path.join(SOUNDFONT_DIR, SOUNDFONT_MAP[instrument_id])
    if not os.path.isfile(sf2_path):
        raise FileNotFoundError(
            f"SoundFont not found: {sf2_path}. "
            f"Place the .sf2 file in {SOUNDFONT_DIR}/"
        )
    return sf2_path


# ── Step 1: Audio → MIDI via basic-pitch ─────────────────────

def audio_to_midi(
    source_path: str,
    midi_output_path: str,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    minimum_note_length: float = 58.0,
) -> str:
    """Transcribe an audio stem to MIDI using Spotify's basic-pitch.

    Parameters:
        source_path (str): Path to the source WAV stem.
        midi_output_path (str): Output path for the .mid file.
        onset_threshold (float): Onset detection threshold.
        frame_threshold (float): Frame activation threshold.
        minimum_note_length (float): Minimum note duration in ms.

    Returns:
        str: Path to the generated MIDI file.
    """
    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except ImportError:
        logger.error(
            "basic-pitch not installed. "
            "Run: pip install basic-pitch"
        )
        sys.exit(1)

    logger.info(f"Transcribing audio to MIDI: {source_path}")

    model_output, midi_data, note_events = predict(
        source_path,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=minimum_note_length,
    )

    midi_data.write(midi_output_path)
    logger.info(
        f"MIDI written: {midi_output_path} "
        f"({len(note_events)} notes)"
    )

    # Free memory from the ML model
    del model_output
    gc.collect()

    return midi_output_path


# ── Step 2: MIDI → Audio via pyfluidsynth ────────────────────

def midi_to_audio(
    midi_path: str,
    soundfont_path: str,
    output_path: str,
    sample_rate: int = 44100,
) -> str:
    """Synthesize a MIDI file using a SoundFont via FluidSynth.

    Parameters:
        midi_path (str): Path to the input MIDI file.
        soundfont_path (str): Path to the .sf2 SoundFont file.
        output_path (str): Output WAV path.
        sample_rate (int): Output sample rate.

    Returns:
        str: Path to the synthesized WAV file.
    """
    try:
        import fluidsynth
    except ImportError:
        logger.error(
            "pyfluidsynth not installed. "
            "Run: pip install pyfluidsynth "
            "(also needs libfluidsynth: brew install fluid-synth)"
        )
        sys.exit(1)

    try:
        import mido
        import numpy as np
        import soundfile as sf
    except ImportError:
        logger.error(
            "mido/numpy/soundfile not installed. "
            "Run: pip install mido numpy soundfile"
        )
        sys.exit(1)

    logger.info(
        f"Synthesizing MIDI with SoundFont: "
        f"{os.path.basename(soundfont_path)}"
    )

    # Initialize FluidSynth
    fs = fluidsynth.Synth(samplerate=float(sample_rate))
    sfid = fs.sfload(soundfont_path)
    fs.program_select(0, sfid, 0, 0)

    # Parse MIDI and calculate total duration
    mid = mido.MidiFile(midi_path)
    total_seconds = mid.length + 1.0
    total_samples = int(total_seconds * sample_rate)

    # Pre-allocate output buffer
    audio_buffer = np.zeros(total_samples, dtype=np.float32)

    # Walk through MIDI events and render
    current_sample = 0
    for msg in mid:
        if msg.time > 0:
            wait_samples = int(msg.time * sample_rate)
            if wait_samples > 0:
                samples = fs.get_samples(wait_samples)
                chunk = np.frombuffer(samples, dtype=np.int16)
                # FluidSynth returns interleaved stereo; take left channel
                mono = chunk[::2].astype(np.float32) / 32768.0
                end_idx = min(
                    current_sample + len(mono), total_samples
                )
                copy_len = end_idx - current_sample
                audio_buffer[current_sample:end_idx] = mono[:copy_len]
                current_sample = end_idx

        if msg.type == "note_on" and msg.velocity > 0:
            fs.noteon(0, msg.note, msg.velocity)
        elif msg.type == "note_off" or (
            msg.type == "note_on" and msg.velocity == 0
        ):
            fs.noteoff(0, msg.note)

    # Render remaining tail (reverb decay)
    tail_samples = int(0.5 * sample_rate)
    tail = fs.get_samples(tail_samples)
    tail_mono = np.frombuffer(tail, dtype=np.int16)[::2].astype(
        np.float32
    ) / 32768.0
    end_idx = min(current_sample + len(tail_mono), total_samples)
    copy_len = end_idx - current_sample
    audio_buffer[current_sample:end_idx] = tail_mono[:copy_len]

    fs.delete()

    # Normalize
    peak = np.max(np.abs(audio_buffer))
    if peak > 0:
        audio_buffer = audio_buffer / peak * 0.95

    sf.write(output_path, audio_buffer, sample_rate)
    logger.info(f"Synthesized audio: {output_path}")

    del audio_buffer
    gc.collect()

    return output_path


# ── Step 3: Post-processing with pedalboard ──────────────────

def post_process(
    input_path: str,
    output_path: str,
    reverb_room_size: float = 0.3,
    reverb_wet: float = 0.15,
    chorus_rate: float = 1.0,
    chorus_depth: float = 0.2,
    chorus_mix: float = 0.3,
) -> str:
    """Apply Reverb and Chorus via Spotify pedalboard.

    Parameters:
        input_path (str): Path to the dry WAV file.
        output_path (str): Output path for the processed WAV.
        reverb_room_size (float): Reverb room size (0-1).
        reverb_wet (float): Reverb wet level (0-1).
        chorus_rate (float): Chorus LFO rate in Hz.
        chorus_depth (float): Chorus depth (0-1).
        chorus_mix (float): Chorus wet/dry mix (0-1).

    Returns:
        str: Path to the processed WAV file.
    """
    try:
        from pedalboard import Pedalboard, Reverb, Chorus
        from pedalboard.io import AudioFile
    except ImportError:
        logger.error(
            "pedalboard not installed. "
            "Run: pip install pedalboard"
        )
        sys.exit(1)

    logger.info("Applying post-processing (Reverb + Chorus)...")

    board = Pedalboard([
        Chorus(
            rate_hz=chorus_rate,
            depth=chorus_depth,
            mix=chorus_mix,
        ),
        Reverb(
            room_size=reverb_room_size,
            wet_level=reverb_wet,
            dry_level=1.0 - reverb_wet,
        ),
    ])

    with AudioFile(input_path) as f:
        with AudioFile(
            output_path, "w", f.samplerate, f.num_channels
        ) as o:
            while f.tell() < f.frames:
                chunk = f.read(int(f.samplerate))
                effected = board(chunk, f.samplerate, reset=False)
                o.write(effected)

    logger.info(f"Post-processed audio: {output_path}")
    return output_path


# ── Full Pipeline ────────────────────────────────────────────

def replace_instrument(
    source_stem_path: str,
    target_instrument_id: str,
    output_path: str,
    original_bpm: Optional[float] = None,
    original_key: Optional[str] = None,
) -> str:
    """Full melody-preserving instrument replacement pipeline.

    Parameters:
        source_stem_path (str): Path to the isolated source stem WAV.
        target_instrument_id (str): Key identifying the replacement
            instrument (maps to a .sf2 SoundFont).
        output_path (str): Path for the final replaced stem WAV.
        original_bpm (float, optional): BPM of the original track.
        original_key (str, optional): Key of the original track.

    Returns:
        str: Path to the replaced stem WAV file.
    """
    if not os.path.isfile(source_stem_path):
        raise FileNotFoundError(
            f"Source stem not found: {source_stem_path}"
        )

    sf2_path = get_soundfont_path(target_instrument_id)

    with tempfile.TemporaryDirectory(
        prefix="remix-replace-"
    ) as tmpdir:
        # Step 1: Audio → MIDI
        midi_path = os.path.join(tmpdir, "transcribed.mid")
        audio_to_midi(source_stem_path, midi_path)

        # Step 2: MIDI → Audio (new instrument)
        raw_synth_path = os.path.join(tmpdir, "raw_synth.wav")
        midi_to_audio(midi_path, sf2_path, raw_synth_path)

        # Step 3: Post-process (Reverb + Chorus)
        post_process(raw_synth_path, output_path)

    logger.info(
        f"Instrument replacement complete: "
        f"{target_instrument_id} → {output_path}"
    )
    return output_path


def main():
    """CLI entry point for instrument replacement."""
    parser = argparse.ArgumentParser(
        description=(
            "Replace an instrument stem while preserving the "
            "original melody"
        )
    )
    parser.add_argument(
        "source", help="Path to source stem WAV"
    )
    parser.add_argument(
        "--instrument", "-i", required=True,
        help=f"Target instrument ID: "
             f"{', '.join(sorted(SOUNDFONT_MAP.keys()))}"
    )
    parser.add_argument(
        "--bpm", type=float, default=None,
        help="Original track BPM"
    )
    parser.add_argument(
        "--key", default=None,
        help="Original track key (e.g. C_minor)"
    )
    parser.add_argument(
        "--output", "-o", default="replaced_stem.wav",
        help="Output path"
    )
    args = parser.parse_args()

    replace_instrument(
        args.source,
        args.instrument,
        args.output,
        original_bpm=args.bpm,
        original_key=args.key,
    )


if __name__ == "__main__":
    main()
