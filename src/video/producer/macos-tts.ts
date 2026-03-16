/**
 * macOS TTS Fallback — uses the built-in `say` command + ffmpeg for MP3 output.
 * Zero configuration required. Falls back automatically when Google Cloud TTS
 * credentials are not available.
 *
 * Issue #243: Director Mode voiceover generation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../../logging/logger.js";

const execFileAsync = promisify(execFile);

/** Default macOS voice for narration (Samantha is clear, widely available) */
const DEFAULT_VOICE = "Samantha";

/** Check whether macOS TTS + ffmpeg are available on this machine. */
export async function isAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("which", ["say"]);
    await execFileAsync("which", ["ffmpeg"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synthesize text to an MP3 file using macOS say → AIFF → ffmpeg → MP3.
 * Returns the absolute path to the generated MP3 file.
 *
 * @param text  - The text to synthesize
 * @param voice - macOS voice name (default: "Samantha"). Run `say -v '?'` to list options.
 */
export async function synthesize(text: string, voice?: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const stamp = Date.now();
  const aiffPath = path.join(tmpDir, `openzigs-tts-${stamp}.aiff`);
  const mp3Path = path.join(tmpDir, `openzigs-tts-${stamp}.mp3`);

  // Write text to a temp file to avoid shell escaping issues with quotes/apostrophes
  const textPath = path.join(tmpDir, `openzigs-tts-${stamp}.txt`);
  await fs.writeFile(textPath, text, "utf-8");

  const selectedVoice = voice ?? DEFAULT_VOICE;

  // Validate voice name: only allow alphanumeric, spaces, hyphens, periods
  if (!/^[\w\s.-]+$/.test(selectedVoice)) {
    throw new Error(`Invalid voice name: ${selectedVoice}`);
  }

  const startMs = Date.now();

  try {
    // Step 1: macOS say → AIFF (execFile avoids shell injection)
    await execFileAsync("say", ["-v", selectedVoice, "-o", aiffPath, "-f", textPath]);

    // Step 2: ffmpeg AIFF → MP3
    await execFileAsync("ffmpeg", ["-i", aiffPath, "-codec:a", "libmp3lame", "-q:a", "2", "-y", mp3Path]);

    const stat = await fs.stat(mp3Path);
    const elapsed = Date.now() - startMs;
    logger.info(
      `[macOS-TTS] Synthesized ${text.length} chars → ${stat.size} bytes in ${elapsed}ms (voice: ${selectedVoice})`,
    );

    return mp3Path;
  } finally {
    // Cleanup intermediary files
    await fs.unlink(aiffPath).catch(() => {});
    await fs.unlink(textPath).catch(() => {});
  }
}
