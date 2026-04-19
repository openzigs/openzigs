import fs from "node:fs";
import path from "node:path";

// Read and base64-encode the reference audio
const refAudioPath = "C:\\Users\\mgbre\\.openzigs\\director\\f5tts-ref-audio\\1775947876572-f5tts-clip-Regular-1775947876553.webm";
const refAudioB64 = fs.readFileSync(refAudioPath).toString("base64");

console.log(`Reference audio: ${refAudioPath}`);
console.log(`Base64 size: ${(refAudioB64.length / 1024).toFixed(1)} KB`);

// Test 1: Very short text
async function testF5TTS(label, genText) {
  console.log(`\n--- ${label} ---`);
  const body = JSON.stringify({
    text: genText,
    clips: [{
      ref_audio: refAudioB64,
      ref_text: "The morning light filtered through the curtains, casting a warm glow across the room.",
      gen_text: genText,
      emotion: "Regular",
      remove_silence: true,
    }],
    speed: 1.0,
    nfe_step: 32,
  });

  const start = Date.now();
  try {
    const res = await fetch("http://localhost:5006/f5tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(180_000),
    });

    if (res.ok) {
      const buf = await res.arrayBuffer();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`OK: ${res.status}, ${(buf.byteLength / 1024).toFixed(0)} KB audio, ${elapsed}s`);
      console.log(`Headers: engine=${res.headers.get("X-Engine")}, time=${res.headers.get("X-Synthesis-Time")}`);
    } else {
      const text = await res.text();
      console.log(`FAILED: ${res.status} - ${text}`);
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

await testF5TTS("Test 1: Short sentence", "Hello, this is a test of the voice cloning system.");
await testF5TTS("Test 2: Medium sentence", "Good morning everyone, and welcome to today's presentation on artificial intelligence and its transformative impact on modern software development.");
await testF5TTS("Test 3: Long paragraph", "Good morning everyone, and welcome to today's presentation on artificial intelligence and its transformative impact on modern software development. Over the past decade, we have witnessed an unprecedented acceleration in the capabilities of machine learning systems. What once required entire teams of specialized engineers can now be accomplished in a matter of hours with the right tools and frameworks. In this session, I want to walk you through three key areas where AI is fundamentally changing how we build and deploy software applications.");

console.log("\nAll tests complete.");
