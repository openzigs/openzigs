/**
 * TTS Text Normalizer — Preprocessing for F5-TTS pronunciation
 *
 * F5-TTS treats lowercase words as pronounceable words and uppercase
 * dot-separated letters (e.g. "K.F.C.") as spelled-out letters.
 * This module normalizes acronyms, abbreviations, and technical terms
 * so they are pronounced correctly by the TTS engine.
 */

/**
 * Common tech acronyms and abbreviations that should be spelled out
 * letter-by-letter rather than pronounced as words.
 *
 * Maps lowercase form → dotted uppercase form for F5-TTS.
 * Only includes terms that are typically spoken as individual letters.
 * Excludes pronounceable acronyms (e.g. "NASA", "SCUBA", "RAM").
 */
const SPELLED_ACRONYMS: Record<string, string> = {
  // Package managers / tools
  npm: "N.P.M.",
  npx: "N.P.X.",
  nvm: "N.V.M.",

  // Web & networking
  api: "A.P.I.",
  apis: "A.P.I.s",
  url: "U.R.L.",
  urls: "U.R.L.s",
  uri: "U.R.I.",
  dns: "D.N.S.",
  ssl: "S.S.L.",
  tls: "T.L.S.",
  tcp: "T.C.P.",
  udp: "U.D.P.",
  ip: "I.P.",
  http: "H.T.T.P.",
  https: "H.T.T.P.S.",
  ssh: "S.S.H.",
  ftp: "F.T.P.",
  cdn: "C.D.N.",
  cors: "C.O.R.S.",

  // AI / ML
  ai: "A.I.",
  ml: "M.L.",
  nlp: "N.L.P.",
  llm: "L.L.M.",
  llms: "L.L.M.s",
  gpu: "G.P.U.",
  gpus: "G.P.U.s",
  cpu: "C.P.U.",
  cpus: "C.P.U.s",
  tts: "T.T.S.",
  stt: "S.T.T.",

  // DevOps / Infra
  ci: "C.I.",
  cd: "C.D.",
  vm: "V.M.",
  vms: "V.M.s",
  os: "O.S.",
  cli: "C.L.I.",
  sdk: "S.D.K.",
  ide: "I.D.E.",

  // Data / Databases
  sql: "S.Q.L.",
  db: "D.B.",
  csv: "C.S.V.",
  json: "J.SON",
  xml: "X.M.L.",
  yaml: "Y.A.M.L.",

  // Programming
  js: "J.S.",
  ts: "T.S.",
  css: "C.S.S.",
  html: "H.T.M.L.",
  jsx: "J.S.X.",
  tsx: "T.S.X.",
  oop: "O.O.P.",
  mvc: "M.V.C.",
  mvp: "M.V.P.",
  ui: "U.I.",
  ux: "U.X.",
  qa: "Q.A.",
  pr: "P.R.",
  prs: "P.R.s",

  // Business / general
  ceo: "C.E.O.",
  cto: "C.T.O.",
  cfo: "C.F.O.",
  vp: "V.P.",
  roi: "R.O.I.",
  kpi: "K.P.I.",
  sla: "S.L.A.",
  faq: "F.A.Q.",
  pdf: "P.D.F.",
  etc: "etcetera",
  diy: "D.I.Y.",
  asap: "A.S.A.P.",
};

/**
 * Regex to find standalone uppercase sequences (2+ letters) that are likely
 * acronyms needing dotted form. Uses a negative lookbehind to avoid matching
 * fragments of already-dotted acronyms (e.g. "SON" from "J.SON").
 */
const UPPERCASE_ACRONYM_RE = /(?<!\.)(?<![A-Za-z])\b([A-Z]{2,})\b/g;

/**
 * Uppercase sequences that are pronounced as words (not spelled out).
 * These should NOT be converted to dotted form.
 */
const PRONOUNCEABLE_UPPERCASE = new Set([
  "NASA", "SCUBA", "NATO", "LASER", "RADAR",
  "CAPTCHA", "JPEG", "GIF", "PIN", "SIM",
  "STEM", "RAM", "ROM", "LAN", "WAN",
  "BASIC", "COBOL", "FORTRAN",
  "OK", "AM", "PM", "AD", "BC",
  "THE", "AND", "BUT", "FOR", "NOR", "YET", "SO",
  "ALSO", "JUST", "VERY", "MUCH", "WELL", "EVEN",
]);

/**
 * Normalize text for F5-TTS pronunciation.
 *
 * - Expands known acronyms (npm → N.P.M.)
 * - Converts unknown uppercase sequences to dotted form (API → A.P.I.)
 * - Preserves words that are pronounceable acronyms (NASA stays NASA)
 *
 * @param text - Raw narration text
 * @returns Normalized text suitable for F5-TTS
 */
export function normalizeForTTS(text: string): string {
  let result = text;

  // Step 0: Convert [PAUSE: Xs] tags into punctuation that F5-TTS respects.
  // F5-TTS docs: "Add some spaces or punctuations (e.g. ',' '.') to explicitly
  // introduce some pauses."  Kokoro handles these tags natively; F5-TTS would
  // try to vocalize them as literal text, so we translate to punctuation:
  //   ≤0.5s  → comma (brief breath pause)
  //   0.5–1.5s → ellipsis (medium pause)
  //   >1.5s  → period + newline (sentence break / long pause)
  // The regex eats surrounding whitespace so we don't get double-spaces.
  result = result.replace(/\s*\[PAUSE:\s*([\d.]+)s\]\s*/gi, (_match, secs) => {
    const duration = parseFloat(secs);
    if (duration <= 0.5) return ", ";
    if (duration <= 1.5) return "... ";
    return ".\n";
  });

  // Strip emphasis markers (*word*) — F5-TTS doesn't support them
  result = result.replace(/\*([^*]+)\*/g, "$1");

  // Step 1: Replace known spelled-out acronyms (case-insensitive, word-boundary)
  for (const [lower, replacement] of Object.entries(SPELLED_ACRONYMS)) {
    // Match the word at word boundaries, case-insensitive
    const re = new RegExp(`\\b${escapeRegex(lower)}\\b`, "gi");
    result = result.replace(re, (match) => {
      // If original was already uppercased with dots, skip
      if (match.includes(".")) return match;
      return replacement;
    });
  }

  // Step 2: Convert remaining uppercase sequences (2+ letters) to dotted form
  // unless they're in the pronounceable set, already dotted, or handled by step 1
  result = result.replace(UPPERCASE_ACRONYM_RE, (match) => {
    if (PRONOUNCEABLE_UPPERCASE.has(match)) return match;
    // Already handled by known acronym map in step 1
    if (SPELLED_ACRONYMS[match.toLowerCase()]) return match;
    // Convert "ABC" → "A.B.C."
    return match.split("").join(".") + ".";
  });

  // Step 3: Clean up redundant punctuation introduced by pause-tag conversion.
  // e.g. "result?..." → "result?", "said..\n" → "said.\n"
  result = result.replace(/([.!?;,])\s*,/g, "$1");        // punct + comma → just punct
  result = result.replace(/([.!?])\s*\.\.\./g, "$1");     // punct + ellipsis → just punct
  result = result.replace(/([.!?])\s*\.\n/g, "$1\n");     // punct + period-newline → punct-newline
  result = result.replace(/\n{2,}/g, "\n");                // collapse multiple newlines

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
