import fs from "node:fs";

// Test with NO reference clips (just text) to see if the sidecar uses default ref audio
const body = JSON.stringify({
  text: "Hello, this is a quick test.",
  clips: [{
    ref_audio: "",
    ref_text: "",
    gen_text: "Hello, this is a quick test.",
    emotion: "Regular",
    remove_silence: true,
  }],
  speed: 1.0,
  nfe_step: 32,
});

console.log("Testing with empty ref_audio...");
const start = Date.now();
try {
  const res = await fetch("http://localhost:5006/f5tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  console.log(`Status: ${res.status}, body size: ${text.length}`);
  if (!res.ok) console.log(text.substring(0, 500));
} catch (err) {
  console.log(`ERROR: ${err.message}`);
}

console.log(`Elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
