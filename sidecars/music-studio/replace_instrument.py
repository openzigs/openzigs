"""
Melody Preservation Engine — Audio-to-MIDI transcription + SoundFont synthesis.

Issue #393: Replace an instrument stem while preserving the original melody:
    1. Detect percussive vs. melodic source (HPSS energy + filename hints).
    2a. [Melodic] Decode notes via basic-pitch; quantize to BPM; filter off-key.
    2b. [Percussive] Extract onset times → rhythmic MIDI at target root pitch.
    3. Normalize MIDI velocities to the target instrument's dynamic profile.
    4. Synthesize the MIDI with a new instrument via pyfluidsynth + .sf2.
    5. Post-process with instrument-specific effects via pedalboard.

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
import math
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

# General MIDI program numbers for fallback when individual SF2s aren't available.
# Uses a single GM SoundFont with the appropriate program change.
GM_PROGRAM_MAP: dict[str, int] = {
    "80s_analog_synth": 81,     # Lead 2 (sawtooth)
    "slap_bass": 36,            # Slap Bass 1
    "grand_piano": 0,           # Acoustic Grand Piano
    "electric_guitar": 27,      # Electric Guitar (clean)
    "acoustic_guitar": 25,      # Acoustic Guitar (steel)
    "strings_ensemble": 48,     # String Ensemble 1
    "brass_section": 61,        # Brass Section
    "flute": 73,                # Flute
    "organ": 19,                # Church Organ
    "marimba": 12,              # Marimba
}

# Known free General MIDI SoundFont to download as fallback
_GM_SOUNDFONT_FILENAME = "GeneralUser_GS_v1.471.sf2"
_GM_SOUNDFONT_URL = (
    "https://archive.org/download/free-soundfonts-sf2-2019-04/GeneralUser%20GS%20v1.471.sf2"
)


# ── Instrument Frequency Ranges (Hz) ────────────────────────
# Constrain basic-pitch output to realistic note ranges per instrument,
# filtering out false note detections that are out of range.
INSTRUMENT_FREQ_RANGE: dict[str, tuple[float, float]] = {
    "80s_analog_synth": (65.0, 4200.0),     # ~C2 – C8
    "slap_bass":        (30.0, 400.0),       # ~B0 – G4
    "grand_piano":      (27.5, 4186.0),      # A0 – C8
    "electric_guitar":  (82.0, 1320.0),      # ~E2 – E6
    "acoustic_guitar":  (82.0, 1320.0),      # ~E2 – E6
    "strings_ensemble": (55.0, 3520.0),      # ~A1 – A7
    "brass_section":    (58.0, 1400.0),      # ~Bb1 – F6
    "flute":            (262.0, 2093.0),     # ~C4 – C7
    "organ":            (32.7, 4186.0),      # ~C1 – C8
    "marimba":          (65.0, 2093.0),      # ~C2 – C7
}


# ── Key & Scale Definitions ──────────────────────────────────
# Maps a key string like "C_minor" to a set of MIDI pitch classes (0-11).
# Used to filter out off-key ghost notes from basic-pitch transcription.

# Semitone offsets for scale patterns
_MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11]
_MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10]

_NOTE_TO_SEMITONE: dict[str, int] = {
    "C": 0, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5,
    "Gb": 6, "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11,
    # Sharp aliases
    "C#": 1, "D#": 3, "F#": 6, "G#": 8, "A#": 10,
}


def _parse_key_to_pitch_classes(key_str: str) -> Optional[set[int]]:
    """Parse a key string like 'C_minor' or 'Ab_major' into a set of
    MIDI pitch classes (0-11) that belong to that scale.

    Returns None if the key string cannot be parsed.
    """
    if not key_str:
        return None

    parts = key_str.replace("-", "_").split("_")
    if len(parts) != 2:
        return None

    root_name, quality = parts[0], parts[1].lower()
    root = _NOTE_TO_SEMITONE.get(root_name)
    if root is None:
        return None

    if quality in ("major", "maj"):
        intervals = _MAJOR_INTERVALS
    elif quality in ("minor", "min"):
        intervals = _MINOR_INTERVALS
    else:
        return None

    return {(root + i) % 12 for i in intervals}


# ── Instrument-Specific Post-Processing Presets ──────────────
INSTRUMENT_FX_PRESETS: dict[str, dict] = {
    "80s_analog_synth": {
        "chorus_rate": 1.5, "chorus_depth": 0.35, "chorus_mix": 0.4,
        "reverb_room": 0.4, "reverb_wet": 0.2,
    },
    "slap_bass": {
        "chorus_rate": 0.0, "chorus_depth": 0.0, "chorus_mix": 0.0,
        "reverb_room": 0.15, "reverb_wet": 0.08,
    },
    "grand_piano": {
        "chorus_rate": 0.0, "chorus_depth": 0.0, "chorus_mix": 0.0,
        "reverb_room": 0.45, "reverb_wet": 0.2,
    },
    "electric_guitar": {
        "chorus_rate": 0.8, "chorus_depth": 0.15, "chorus_mix": 0.2,
        "reverb_room": 0.3, "reverb_wet": 0.15,
    },
    "acoustic_guitar": {
        "chorus_rate": 0.5, "chorus_depth": 0.1, "chorus_mix": 0.15,
        "reverb_room": 0.35, "reverb_wet": 0.18,
    },
    "strings_ensemble": {
        "chorus_rate": 0.6, "chorus_depth": 0.25, "chorus_mix": 0.3,
        "reverb_room": 0.55, "reverb_wet": 0.3,
    },
    "brass_section": {
        "chorus_rate": 0.0, "chorus_depth": 0.0, "chorus_mix": 0.0,
        "reverb_room": 0.35, "reverb_wet": 0.18,
    },
    "flute": {
        "chorus_rate": 0.4, "chorus_depth": 0.1, "chorus_mix": 0.15,
        "reverb_room": 0.5, "reverb_wet": 0.25,
    },
    "organ": {
        "chorus_rate": 5.5, "chorus_depth": 0.3, "chorus_mix": 0.35,
        "reverb_room": 0.45, "reverb_wet": 0.2,
    },
    "marimba": {
        "chorus_rate": 0.0, "chorus_depth": 0.0, "chorus_mix": 0.0,
        "reverb_room": 0.3, "reverb_wet": 0.12,
    },
}


# ── Instrument Velocity Profiles ────────────────────────────
# Defines per-instrument MIDI velocity remapping applied after transcription.
#   min_vel / max_vel: output velocity range clamped to [1, 127]
#   curve:  "linear"     — proportional rescale into [min_vel, max_vel]
#           "compressed" — soft-knee; pulls velocities toward the midpoint
#                          (less dynamic variation; good for bass/organ)
#           "exp"        — power curve; enhances soft/loud contrasts
#                          (good for strings/pads with natural swells)
INSTRUMENT_VELOCITY_PROFILES: dict[str, dict] = {
    "80s_analog_synth": {"min_vel": 60, "max_vel": 110, "curve": "linear"},
    "slap_bass":        {"min_vel": 90, "max_vel": 127, "curve": "compressed"},
    "grand_piano":      {"min_vel": 40, "max_vel": 110, "curve": "linear"},
    "electric_guitar":  {"min_vel": 65, "max_vel": 115, "curve": "linear"},
    "acoustic_guitar":  {"min_vel": 55, "max_vel": 105, "curve": "linear"},
    "strings_ensemble": {"min_vel": 50, "max_vel": 100, "curve": "exp"},
    "brass_section":    {"min_vel": 70, "max_vel": 120, "curve": "linear"},
    "flute":            {"min_vel": 45, "max_vel":  90, "curve": "linear"},
    "organ":            {"min_vel": 80, "max_vel": 110, "curve": "compressed"},
    "marimba":          {"min_vel": 60, "max_vel": 110, "curve": "linear"},
}

# Root MIDI pitch used when building rhythmic MIDI from a percussive source.
# Chosen to sit comfortably in each instrument's natural range.
INSTRUMENT_RHYTHMIC_ROOT: dict[str, int] = {
    "80s_analog_synth": 60,  # C4
    "slap_bass":        40,  # E2
    "grand_piano":      60,  # C4
    "electric_guitar":  52,  # E3
    "acoustic_guitar":  52,  # E3
    "strings_ensemble": 55,  # G3
    "brass_section":    58,  # Bb3
    "flute":            65,  # F4
    "organ":            60,  # C4
    "marimba":          60,  # C4
}

# Filename keywords that hint the stem is unpitched percussion
_PERCUSSIVE_STEM_KEYWORDS = frozenset({
    "drum", "drums", "perc", "percussion",
    "kick", "snare", "hihat", "hi-hat", "hat",
    "cymbal", "tom", "clap", "trap",
})


def _download_gm_soundfont() -> str:
    """Download a free General MIDI SoundFont if none exists locally."""
    from urllib.request import urlopen, Request

    sf_path = os.path.join(SOUNDFONT_DIR, _GM_SOUNDFONT_FILENAME)
    if os.path.isfile(sf_path):
        return sf_path

    os.makedirs(SOUNDFONT_DIR, exist_ok=True)

    # Check if any .sf2 file already exists that we can use
    for f in os.listdir(SOUNDFONT_DIR):
        if f.lower().endswith(".sf2"):
            logger.info(f"Found existing GM SoundFont: {f}")
            return os.path.join(SOUNDFONT_DIR, f)

    logger.info(
        f"Downloading General MIDI SoundFont to {sf_path} "
        f"(one-time setup, ~30 MB)..."
    )
    tmp_path = sf_path + ".tmp"
    try:
        req = Request(_GM_SOUNDFONT_URL, headers={"User-Agent": "openzigs/1.0"})
        with urlopen(req, timeout=120) as resp, open(tmp_path, "wb") as out:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                out.write(chunk)
        os.rename(tmp_path, sf_path)
        logger.info(f"SoundFont downloaded: {sf_path}")
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

    return sf_path


def get_soundfont_path(instrument_id: str) -> tuple[str, int]:
    """Resolve the absolute path to a .sf2 SoundFont file.

    Returns a tuple of (sf2_path, gm_program_number).
    If an instrument-specific .sf2 exists, returns (path, 0).
    Otherwise falls back to a General MIDI SoundFont with the
    appropriate program number.

    Parameters:
        instrument_id (str): Key from SOUNDFONT_MAP.

    Returns:
        tuple[str, int]: (path to .sf2 file, GM program number)

    Raises:
        ValueError: If the instrument_id is unknown.
    """
    if instrument_id not in SOUNDFONT_MAP:
        available = ", ".join(sorted(SOUNDFONT_MAP.keys()))
        raise ValueError(
            f"Unknown instrument '{instrument_id}'. "
            f"Available: {available}"
        )

    # Try instrument-specific SoundFont first
    sf2_path = os.path.join(SOUNDFONT_DIR, SOUNDFONT_MAP[instrument_id])
    if os.path.isfile(sf2_path):
        return sf2_path, 0

    # Fall back to a General MIDI SoundFont
    logger.info(
        f"Instrument SF2 not found ({SOUNDFONT_MAP[instrument_id]}), "
        f"falling back to General MIDI SoundFont"
    )
    gm_path = _download_gm_soundfont()
    program = GM_PROGRAM_MAP.get(instrument_id, 0)
    return gm_path, program


# ── Percussion Detection & Rhythmic MIDI ────────────────────

def _is_percussive_source(audio_path: str) -> tuple[bool, float]:
    """Detect whether an audio stem is primarily unpitched percussion.

    Uses two signals in order:
    1. Filename keyword matching — fast, zero-cost check.
    2. Librosa HPSS energy ratio — analyzes up to 30s of audio.

    Parameters:
        audio_path (str): Path to the audio file.

    Returns:
        tuple[bool, float]: (is_percussive, harmonic_ratio)
            harmonic_ratio is 0-1; values below 0.25 indicate percussion.
    """
    import re

    # --- Signal 1: filename keyword check ---
    stem_name = os.path.splitext(os.path.basename(audio_path))[0].lower()
    tokens = set(re.split(r"[\s_\-\.]+", stem_name))
    if tokens & _PERCUSSIVE_STEM_KEYWORDS:
        logger.info(f"  Percussion detected via filename keyword: {stem_name}")
        return True, 0.0

    # --- Signal 2: harmonic/percussive energy ratio via librosa HPSS ---
    try:
        import librosa
        import numpy as np
    except ImportError:
        logger.warning(
            "librosa not available — skipping harmonic analysis. "
            "Install with: pip install librosa"
        )
        return False, 1.0

    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=30.0)
        harmonic, percussive = librosa.effects.hpss(y)
        h_energy = float(np.mean(harmonic ** 2))
        p_energy = float(np.mean(percussive ** 2))
        total = h_energy + p_energy
        harmonic_ratio = h_energy / total if total > 0 else 1.0
        is_percussive = harmonic_ratio < 0.25
        logger.info(
            f"  HPSS harmonic ratio: {harmonic_ratio:.3f} "
            f"({'percussive' if is_percussive else 'harmonic'} source)"
        )
        return is_percussive, harmonic_ratio
    except Exception as exc:
        logger.warning(f"Harmonic analysis failed: {exc}")
        return False, 1.0


def _build_rhythmic_midi(
    audio_path: str,
    midi_output_path: str,
    root_pitch: int = 60,
    bpm: Optional[float] = None,
) -> str:
    """Convert a percussive stem into a rhythmic MIDI pattern.

    Rather than running melodic transcription on unpitched audio
    (which produces random note garbage), this extracts drum onset
    times with librosa and creates a MIDI file where each onset
    triggers the target instrument's root pitch. Velocity is mapped
    from the onset envelope strength, preserving the original dynamics.

    Parameters:
        audio_path (str): Path to the source percussive audio.
        midi_output_path (str): Output path for the .mid file.
        root_pitch (int): MIDI note number for the target instrument root.
        bpm (float, optional): Track BPM; estimated from audio if None.

    Returns:
        str: Path to the generated MIDI file.
    """
    try:
        import librosa
        import numpy as np
        import pretty_midi
    except ImportError:
        raise RuntimeError(
            "librosa and pretty_midi are required. "
            "Run: pip install librosa pretty_midi"
        )

    logger.info(
        f"Building rhythmic MIDI from percussive source "
        f"(root MIDI pitch: {root_pitch})..."
    )

    y, sr = librosa.load(audio_path, sr=22050, mono=True)

    if bpm is None:
        estimated_bpm, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(estimated_bpm)
        logger.info(f"  Estimated BPM: {bpm:.1f}")

    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, units="frames", hop_length=512
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=512)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512)
    max_strength = float(np.max(onset_env)) if np.max(onset_env) > 0 else 1.0

    note_duration = max(60.0 / bpm / 2.0, 0.05)  # 8th-note or 50 ms minimum

    midi = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    instr = pretty_midi.Instrument(program=0)  # program overridden by FluidSynth

    for t in onset_times:
        frame = min(int(librosa.time_to_frames(t, sr=sr, hop_length=512)),
                    len(onset_env) - 1)
        strength = float(onset_env[frame])
        velocity = int(60 + (strength / max_strength) * 50)
        velocity = max(60, min(110, velocity))
        instr.notes.append(pretty_midi.Note(
            velocity=velocity,
            pitch=root_pitch,
            start=float(t),
            end=float(t) + note_duration,
        ))

    midi.instruments.append(instr)
    midi.write(midi_output_path)
    logger.info(
        f"  Rhythmic MIDI written: {len(onset_times)} hits → {midi_output_path}"
    )
    return midi_output_path


# ── Step 1: Audio → MIDI via basic-pitch ─────────────────────

def audio_to_midi(
    source_path: str,
    midi_output_path: str,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    minimum_note_length: float = 58.0,
    minimum_frequency: Optional[float] = None,
    maximum_frequency: Optional[float] = None,
) -> str:
    """Transcribe an audio stem to MIDI using Spotify's basic-pitch.

    Parameters:
        source_path (str): Path to the source WAV stem.
        midi_output_path (str): Output path for the .mid file.
        onset_threshold (float): Onset detection threshold.
        frame_threshold (float): Frame activation threshold.
        minimum_note_length (float): Minimum note duration in ms.
        minimum_frequency (float, optional): Min output frequency in Hz.
        maximum_frequency (float, optional): Max output frequency in Hz.

    Returns:
        str: Path to the generated MIDI file.
    """
    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except ImportError:
        raise RuntimeError(
            "basic-pitch not installed. "
            "Run: pip install 'basic-pitch[onnx]'"
        )

    logger.info(f"Transcribing audio to MIDI: {source_path}")
    if minimum_frequency or maximum_frequency:
        logger.info(
            f"  Frequency filter: {minimum_frequency or '—'}Hz – "
            f"{maximum_frequency or '—'}Hz"
        )

    model_output, midi_data, note_events = predict(
        source_path,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=minimum_note_length,
        minimum_frequency=minimum_frequency,
        maximum_frequency=maximum_frequency,
        multiple_pitch_bends=True,
        melodia_trick=True,
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


# ── Step 1b: MIDI Quantization & Key Filtering ──────────────

def quantize_midi(
    midi_path: str,
    bpm: Optional[float] = None,
    key_pitch_classes: Optional[set[int]] = None,
) -> str:
    """Quantize MIDI note timing to a BPM grid and remove off-key notes.

    Operates in-place on the MIDI file. This cleans up transcription
    artifacts from basic-pitch, snapping note onsets to the nearest
    subdivision and filtering notes that don't belong to the key.

    Parameters:
        midi_path (str): Path to the MIDI file (modified in-place).
        bpm (float, optional): BPM for quantization grid. If None, skips.
        key_pitch_classes (set[int], optional): MIDI pitch classes (0-11)
            that belong to the song's key. Notes outside are removed.

    Returns:
        str: The same midi_path (modified in-place).
    """
    try:
        import pretty_midi
    except ImportError:
        raise RuntimeError("pretty_midi not installed. Run: pip install pretty_midi")

    midi = pretty_midi.PrettyMIDI(midi_path)
    notes_removed = 0
    notes_quantized = 0

    for instrument in midi.instruments:
        filtered_notes = []
        for note in instrument.notes:
            # Filter off-key notes
            if key_pitch_classes is not None:
                pitch_class = note.pitch % 12
                if pitch_class not in key_pitch_classes:
                    notes_removed += 1
                    continue

            # Quantize timing to BPM grid (1/16th note resolution)
            if bpm is not None and bpm > 0:
                sixteenth = 60.0 / bpm / 4.0  # duration of a 1/16th note
                note.start = round(note.start / sixteenth) * sixteenth
                # Preserve note duration, don't quantize end independently
                duration = max(note.end - note.start, sixteenth * 0.5)
                note.end = note.start + duration
                notes_quantized += 1

            filtered_notes.append(note)
        instrument.notes = filtered_notes

    if notes_removed > 0:
        logger.info(f"  Key filter: removed {notes_removed} off-key notes")
    if notes_quantized > 0:
        logger.info(f"  Quantized {notes_quantized} notes to {bpm} BPM grid")

    midi.write(midi_path)
    return midi_path


def normalize_midi_velocities(midi_path: str, instrument_id: str) -> str:
    """Remap MIDI note velocities to match a target instrument's dynamic profile.

    basic-pitch tends to produce velocities clustered in the 80-100 range
    regardless of the actual performance dynamics. This remaps them into
    the characteristic range of the target instrument.

    Curve types:
        linear:     proportional rescale into [min_vel, max_vel]
        compressed: soft-knee; pulls velocities toward the midpoint
        exp:        power curve (^0.7) that enhances soft/loud contrasts

    Parameters:
        midi_path (str): Path to the MIDI file (modified in-place).
        instrument_id (str): Target instrument ID for profile lookup.

    Returns:
        str: The same midi_path (modified in-place).
    """
    try:
        import pretty_midi
    except ImportError:
        raise RuntimeError("pretty_midi not installed. Run: pip install pretty_midi")

    profile = INSTRUMENT_VELOCITY_PROFILES.get(instrument_id)
    if not profile:
        return midi_path

    min_vel = profile["min_vel"]
    max_vel = profile["max_vel"]
    curve = profile.get("curve", "linear")

    midi = pretty_midi.PrettyMIDI(midi_path)
    total_remapped = 0

    for instr in midi.instruments:
        for note in instr.notes:
            v_norm = note.velocity / 127.0  # normalise to 0-1

            if curve == "compressed":
                # Soft-knee: pull toward centre, reducing extremes
                v_norm = 0.5 + (v_norm - 0.5) * 0.55
            elif curve == "exp":
                # Power < 1 brightens the dynamic curve (more contrast)
                v_norm = v_norm ** 0.7

            new_vel = int(min_vel + v_norm * (max_vel - min_vel))
            note.velocity = max(1, min(127, new_vel))
            total_remapped += 1

    if total_remapped > 0:
        logger.info(
            f"  Velocity normalized: {total_remapped} notes "
            f"→ [{min_vel}-{max_vel}] ({curve} curve)"
        )

    midi.write(midi_path)
    return midi_path


# ── Step 2: MIDI → Audio via pyfluidsynth ────────────────────

def midi_to_audio(
    midi_path: str,
    soundfont_path: str,
    output_path: str,
    sample_rate: int = 44100,
    program: int = 0,
) -> str:
    """Synthesize a MIDI file using a SoundFont via FluidSynth.

    Parameters:
        midi_path (str): Path to the input MIDI file.
        soundfont_path (str): Path to the .sf2 SoundFont file.
        output_path (str): Output WAV path.
        sample_rate (int): Output sample rate.
        program (int): GM program number (0-127) for instrument selection.

    Returns:
        str: Path to the synthesized WAV file.
    """
    try:
        import fluidsynth
    except ImportError:
        raise RuntimeError(
            "pyfluidsynth not installed. "
            "Run: pip install pyfluidsynth "
            "(also needs libfluidsynth: brew install fluid-synth)"
        )

    try:
        import mido
        import numpy as np
        import soundfile as sf
    except ImportError:
        raise RuntimeError(
            "mido/numpy/soundfile not installed. "
            "Run: pip install mido numpy soundfile"
        )

    logger.info(
        f"Synthesizing MIDI with SoundFont: "
        f"{os.path.basename(soundfont_path)}"
    )

    # Initialize FluidSynth
    fs = fluidsynth.Synth(samplerate=float(sample_rate))
    sfid = fs.sfload(soundfont_path)
    fs.program_select(0, sfid, 0, program)

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
    instrument_id: Optional[str] = None,
    reverb_room_size: Optional[float] = None,
    reverb_wet: Optional[float] = None,
    chorus_rate: Optional[float] = None,
    chorus_depth: Optional[float] = None,
    chorus_mix: Optional[float] = None,
) -> str:
    """Apply instrument-specific effects via Spotify pedalboard.

    If instrument_id is provided, uses the preset FX chain for that
    instrument. Manual parameters override the preset values.

    Parameters:
        input_path (str): Path to the dry WAV file.
        output_path (str): Output path for the processed WAV.
        instrument_id (str, optional): Instrument ID for preset lookup.
        reverb_room_size (float, optional): Override reverb room size (0-1).
        reverb_wet (float, optional): Override reverb wet level (0-1).
        chorus_rate (float, optional): Override chorus LFO rate in Hz.
        chorus_depth (float, optional): Override chorus depth (0-1).
        chorus_mix (float, optional): Override chorus wet/dry mix (0-1).

    Returns:
        str: Path to the processed WAV file.
    """
    try:
        from pedalboard import Pedalboard, Reverb, Chorus
        from pedalboard.io import AudioFile
    except ImportError:
        raise RuntimeError(
            "pedalboard not installed. "
            "Run: pip install pedalboard"
        )

    # Resolve FX parameters: preset → manual overrides
    preset = INSTRUMENT_FX_PRESETS.get(instrument_id or "", {})
    fx_chorus_rate = chorus_rate if chorus_rate is not None else preset.get("chorus_rate", 1.0)
    fx_chorus_depth = chorus_depth if chorus_depth is not None else preset.get("chorus_depth", 0.2)
    fx_chorus_mix = chorus_mix if chorus_mix is not None else preset.get("chorus_mix", 0.3)
    fx_reverb_room = reverb_room_size if reverb_room_size is not None else preset.get("reverb_room", 0.3)
    fx_reverb_wet = reverb_wet if reverb_wet is not None else preset.get("reverb_wet", 0.15)

    logger.info(
        f"Applying post-processing"
        f"{f' (preset: {instrument_id})' if instrument_id and preset else ''}:"
        f" Chorus({fx_chorus_rate}Hz,{fx_chorus_depth},{fx_chorus_mix})"
        f" Reverb({fx_reverb_room},{fx_reverb_wet})"
    )

    effects = []
    if fx_chorus_mix > 0:
        effects.append(Chorus(
            rate_hz=fx_chorus_rate,
            depth=fx_chorus_depth,
            mix=fx_chorus_mix,
        ))
    effects.append(Reverb(
        room_size=fx_reverb_room,
        wet_level=fx_reverb_wet,
        dry_level=1.0 - fx_reverb_wet,
    ))

    board = Pedalboard(effects)

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
        original_bpm (float, optional): BPM of the original track
            (used for quantizing MIDI timing to the beat grid).
        original_key (str, optional): Key of the original track
            (e.g. 'C_minor') — used to filter out off-key ghost notes.

    Returns:
        str: Path to the replaced stem WAV file.
    """
    if not os.path.isfile(source_stem_path):
        raise FileNotFoundError(
            f"Source stem not found: {source_stem_path}"
        )

    sf2_path, gm_program = get_soundfont_path(target_instrument_id)

    # Look up target instrument frequency range for filtering
    freq_range = INSTRUMENT_FREQ_RANGE.get(target_instrument_id)
    min_freq = freq_range[0] if freq_range else None
    max_freq = freq_range[1] if freq_range else None

    # Parse key for off-key note filtering
    key_pitch_classes = _parse_key_to_pitch_classes(original_key) if original_key else None

    # Detect whether the source stem is percussive (drums, etc.)
    is_percussive, harmonic_ratio = _is_percussive_source(source_stem_path)
    if is_percussive:
        logger.warning(
            f"Percussive source detected (harmonic ratio: {harmonic_ratio:.3f}). "
            f"Switching to onset-based rhythmic MIDI — melodic transcription on "
            f"drums produces unreliable results."
        )

    logger.info(
        f"Replace pipeline: {os.path.basename(source_stem_path)} → "
        f"{target_instrument_id}"
        f"{f' | BPM={original_bpm}' if original_bpm else ''}"
        f"{f' | key={original_key}' if original_key else ''}"
        f" | source={'percussive' if is_percussive else 'melodic'}"
    )

    with tempfile.TemporaryDirectory(
        prefix="remix-replace-"
    ) as tmpdir:
        midi_path = os.path.join(tmpdir, "transcribed.mid")

        if is_percussive:
            # Percussive path: extract onset times → rhythmic MIDI at root pitch
            root_pitch = INSTRUMENT_RHYTHMIC_ROOT.get(target_instrument_id, 60)
            _build_rhythmic_midi(
                source_stem_path, midi_path,
                root_pitch=root_pitch,
                bpm=original_bpm,
            )
        else:
            # Melodic path: ML transcription with frequency filtering
            audio_to_midi(
                source_stem_path,
                midi_path,
                minimum_frequency=min_freq,
                maximum_frequency=max_freq,
            )
            # Quantize timing + filter off-key notes
            if original_bpm or key_pitch_classes:
                quantize_midi(
                    midi_path,
                    bpm=original_bpm,
                    key_pitch_classes=key_pitch_classes,
                )

        # Normalize velocities to the target instrument's dynamic profile
        normalize_midi_velocities(midi_path, target_instrument_id)

        # Step 2: MIDI → Audio (new instrument)
        raw_synth_path = os.path.join(tmpdir, "raw_synth.wav")
        midi_to_audio(midi_path, sf2_path, raw_synth_path, program=gm_program)

        # Step 3: Post-process (instrument-specific FX chain)
        post_process(raw_synth_path, output_path, instrument_id=target_instrument_id)

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
