"""Direct test of F5-TTS inference to debug tensor mismatch."""
import sys, os, tempfile, subprocess, time

# Test parameters
REF_AUDIO = "C:\\Users\\mgbre\\.openzigs\\director\\f5tts-ref-audio\\1775947876572-f5tts-clip-Regular-1775947876553.webm"
REF_TEXT = "The morning light filtered through the curtains, casting a warm glow across the room."
GEN_TEXT = "Good morning everyone, and welcome to today's presentation on artificial intelligence."

# Map Windows path to WSL if running in WSL
ref_audio = REF_AUDIO.replace("C:\\", "/mnt/c/").replace("\\", "/")

# Convert to 24kHz mono WAV
tmp_wav = tempfile.mktemp(suffix=".wav")
subprocess.run(["ffmpeg", "-y", "-i", ref_audio, "-ar", "24000", "-ac", "1", "-t", "15", "-c:a", "pcm_s16le", tmp_wav],
               capture_output=True, check=True)
print(f"Converted reference audio to: {tmp_wav}")

# Check audio file
import soundfile as sf
data, sr = sf.read(tmp_wav)
print(f"Reference audio: {len(data)} samples, {sr}Hz, {len(data)/sr:.1f}s")

# Load F5-TTS
from f5_tts.api import F5TTS
print("Loading F5-TTS model...")
t0 = time.time()
model = F5TTS(model="F5TTS_v1_Base", device="cuda")
print(f"Model loaded in {time.time()-t0:.1f}s")

# Test 1: Short text
print("\n--- Test 1: Short sentence ---")
try:
    t0 = time.time()
    wav, sr, _ = model.infer(
        ref_file=tmp_wav,
        ref_text=REF_TEXT,
        gen_text=GEN_TEXT,
        show_info=lambda *a, **k: None,
        progress=None,
        nfe_step=16,
    )
    print(f"OK: {len(wav)} samples, {sr}Hz, {len(wav)/sr:.1f}s in {time.time()-t0:.1f}s")
except Exception as e:
    print(f"FAILED: {e}")

# Test 2: Longer text (what's actually being sent)
print("\n--- Test 2: Longer text ---")
long_text = "Good morning everyone, and welcome to today's presentation on artificial intelligence and its transformative impact on modern software development. Over the past decade, we have witnessed an unprecedented acceleration in the capabilities of machine learning systems."
try:
    t0 = time.time()
    wav, sr, _ = model.infer(
        ref_file=tmp_wav,
        ref_text=REF_TEXT,
        gen_text=long_text,
        show_info=lambda *a, **k: None,
        progress=None,
        nfe_step=16,
    )
    print(f"OK: {len(wav)} samples, {sr}Hz, {len(wav)/sr:.1f}s in {time.time()-t0:.1f}s")
except Exception as e:
    print(f"FAILED: {e}")

# Test 3: Full paragraph
print("\n--- Test 3: Full paragraph ---")
full_text = "Good morning everyone, and welcome to today's presentation on artificial intelligence and its transformative impact on modern software development. Over the past decade, we have witnessed an unprecedented acceleration in the capabilities of machine learning systems. What once required entire teams of specialized engineers can now be accomplished in a matter of hours with the right tools and frameworks. In this session, I want to walk you through three key areas where AI is fundamentally changing how we build and deploy software applications."
try:
    t0 = time.time()
    wav, sr, _ = model.infer(
        ref_file=tmp_wav,
        ref_text=REF_TEXT,
        gen_text=full_text,
        show_info=lambda *a, **k: None,
        progress=None,
        nfe_step=16,
    )
    print(f"OK: {len(wav)} samples, {sr}Hz, {len(wav)/sr:.1f}s in {time.time()-t0:.1f}s")
except Exception as e:
    print(f"FAILED: {e}")

os.unlink(tmp_wav)
print("\nDone.")
