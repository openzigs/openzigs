/**
 * TTS Text Normalizer — Preprocessing for F5-TTS pronunciation
 *
 * F5-TTS uses raw BPE tokenization (~12k tokens) with NO built-in G2P module.
 * Dots within words (e.g. "A.I.", "N.P.M.") confuse both the sentence splitter
 * and the BPE tokenizer, causing hallucinations and off-script output.
 *
 * This module expands acronyms and abbreviations to their PHONETIC spoken forms
 * (e.g. "AI" → "ay eye", "NPM" → "en pee em") so F5-TTS can pronounce them
 * correctly without encountering ambiguous dot-separated token boundaries.
 */

/**
 * Phonetic letter pronunciations used for spelling out acronyms.
 */
const LETTER_PHONETICS: Record<string, string> = {
  A: "ay", B: "bee", C: "see", D: "dee", E: "ee", F: "eff",
  G: "gee", H: "aitch", I: "eye", J: "jay", K: "kay", L: "ell",
  M: "em", N: "en", O: "oh", P: "pee", Q: "cue", R: "are",
  S: "ess", T: "tee", U: "you", V: "vee", W: "double you",
  X: "ex", Y: "why", Z: "zee",
};

/**
 * Digit pronunciations for mixed alphanumeric expansion.
 */
const DIGIT_WORDS: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
};

/**
 * Common acronyms and abbreviations mapped to their phonetic spoken forms.
 * Only includes terms that are typically spoken as individual letters.
 * Excludes pronounceable acronyms (e.g. "NASA", "SCUBA", "RAM").
 */
const SPOKEN_EXPANSIONS: Record<string, string> = {
  // Package managers / tools
  npm: "en pee em",
  npx: "en pee ex",
  nvm: "en vee em",

  // Web & networking
  api: "ay pee eye",
  apis: "ay pee eyes",
  url: "you are ell",
  urls: "you are ells",
  uri: "you are eye",
  dns: "dee en ess",
  ssl: "ess ess ell",
  tls: "tee ell ess",
  tcp: "tee see pee",
  udp: "you dee pee",
  ip: "eye pee",
  http: "aitch tee tee pee",
  https: "aitch tee tee pee ess",
  ssh: "ess ess aitch",
  ftp: "eff tee pee",
  cdn: "see dee en",
  cors: "see oh are ess",

  // AI / ML
  ai: "ay eye",
  ml: "em ell",
  nlp: "en ell pee",
  llm: "ell ell em",
  llms: "ell ell ems",
  gpu: "gee pee you",
  gpus: "gee pee yous",
  cpu: "see pee you",
  cpus: "see pee yous",
  tts: "tee tee ess",
  stt: "ess tee tee",

  // DevOps / Infra
  ci: "see eye",
  cd: "see dee",
  vm: "vee em",
  vms: "vee ems",
  os: "oh ess",
  cli: "see ell eye",
  sdk: "ess dee kay",
  ide: "eye dee ee",

  // Data / Databases
  sql: "ess cue ell",
  db: "dee bee",
  csv: "see ess vee",
  json: "Jason",
  xml: "ex em ell",
  yaml: "why ay em ell",

  // Programming
  js: "jay ess",
  ts: "tee ess",
  css: "see ess ess",
  html: "aitch tee em ell",
  jsx: "jay ess ex",
  tsx: "tee ess ex",
  oop: "oh oh pee",
  mvc: "em vee see",
  mvp: "em vee pee",
  ui: "you eye",
  ux: "you ex",
  qa: "cue ay",
  pr: "pee are",
  prs: "pee ares",

  // Business / general
  ceo: "see ee oh",
  cto: "see tee oh",
  cfo: "see eff oh",
  vp: "vee pee",
  roi: "are oh eye",
  kpi: "kay pee eye",
  sla: "ess ell ay",
  faq: "eff ay cue",
  pdf: "pee dee eff",
  etc: "etcetera",
  diy: "dee eye why",
  asap: "ay ess ay pee",
};

/**
 * Common abbreviations with dots that should be expanded to words.
 */
const DOTTED_ABBREVIATIONS: Record<string, string> = {
  "dr.": "Doctor",
  "mr.": "Mister",
  "mrs.": "Missus",
  "ms.": "Mizz",
  "prof.": "Professor",
  "vs.": "versus",
  "etc.": "etcetera",
  "e.g.": "for example",
  "i.e.": "that is",
  "st.": "Saint",
  "jr.": "Junior",
  "sr.": "Senior",
  "inc.": "Incorporated",
  "ltd.": "Limited",
  "dept.": "Department",
  "approx.": "approximately",
  "govt.": "government",
};

/**
 * Regex to find standalone uppercase sequences (2+ letters) that are likely
 * acronyms needing phonetic expansion.
 */
const UPPERCASE_ACRONYM_RE = /(?<!\.)(?<![A-Za-z])\b([A-Z]{2,})\b/g;

/**
 * Regex to match already-dotted abbreviations like "A.I.", "U.S.A.", "M.P.4"
 * Captures sequences of single uppercase letters or digits separated by dots,
 * with an optional trailing dot.
 */
const DOTTED_ACRONYM_RE = /(?<![A-Za-z])([A-Z0-9]\.){2,}[A-Z0-9]?/g;

/**
 * Regex to match mixed alphanumeric terms like "MP4", "H264", "4K", "3D".
 */
const MIXED_ALPHANUM_RE = /\b([A-Z]+)(\d+)\b/g;
const NUM_ALPHA_RE = /\b(\d+)([A-Z]+)\b/g;

/**
 * Uppercase sequences that are pronounced as words (not spelled out).
 * These should NOT be expanded to phonetic letter forms.
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
 * Expand a sequence of uppercase letters to their phonetic spoken forms.
 */
function spellOutLetters(letters: string): string {
  return letters
    .split("")
    .map((ch) => LETTER_PHONETICS[ch] ?? ch)
    .join(" ");
}

/**
 * Expand a number string to its spoken word form.
 */
function expandNumber(num: string): string {
  const n = parseInt(num, 10);
  if (isNaN(n)) return num;
  // Simple cases
  if (n >= 0 && n <= 9) return DIGIT_WORDS[num] ?? num;
  // Common compound numbers
  const COMMON_NUMBERS: Record<number, string> = {
    10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
    15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen",
    20: "twenty", 30: "thirty", 40: "forty", 50: "fifty", 60: "sixty",
    64: "sixty four", 70: "seventy", 80: "eighty", 90: "ninety",
    100: "one hundred", 128: "one twenty eight", 256: "two fifty six",
    264: "two sixty four", 265: "two sixty five", 320: "three twenty",
    360: "three sixty", 480: "four eighty", 720: "seven twenty",
    1080: "ten eighty",
  };
  if (COMMON_NUMBERS[n]) return COMMON_NUMBERS[n];
  // Fall back to digit-by-digit for unfamiliar numbers
  return num.split("").map((d) => DIGIT_WORDS[d] ?? d).join(" ");
}

/**
 * Normalize text for F5-TTS pronunciation.
 *
 * - Converts PAUSE tags to punctuation pauses
 * - Strips emphasis markers (unsupported by F5-TTS)
 * - Expands dotted abbreviations (Dr., Mr., e.g., etc.)
 * - Expands already-dotted acronyms (A.I. → ay eye)
 * - Expands known acronyms to phonetic spoken forms (API → ay pee eye)
 * - Expands mixed alphanumeric terms (MP4 → em pee four)
 * - Expands unknown uppercase sequences to phonetic forms
 * - Preserves pronounceable acronyms (NASA stays NASA)
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

  // Step 1: Expand common dotted abbreviations (Dr., Mr., e.g., etc.)
  // Use word boundary before the abbreviation to avoid matching fragments
  // like "ms." inside "acronyms."
  for (const [abbr, expansion] of Object.entries(DOTTED_ABBREVIATIONS)) {
    const re = new RegExp(`(?<![A-Za-z])${escapeRegex(abbr)}`, "gi");
    result = result.replace(re, expansion);
  }

  // Step 2: Expand already-dotted acronyms (A.I. → ay eye, M.P.4 → em pee four)
  result = result.replace(DOTTED_ACRONYM_RE, (match) => {
    // Strip dots and expand each character
    const chars = match.replace(/\./g, "");
    return chars
      .split("")
      .map((ch) => {
        if (/[A-Z]/.test(ch)) return LETTER_PHONETICS[ch] ?? ch;
        if (/[0-9]/.test(ch)) return expandNumber(ch);
        return ch;
      })
      .join(" ");
  });

  // Step 3: Replace known spelled-out acronyms (case-insensitive, word-boundary)
  for (const [lower, replacement] of Object.entries(SPOKEN_EXPANSIONS)) {
    const re = new RegExp(`\\b${escapeRegex(lower)}\\b`, "gi");
    result = result.replace(re, replacement);
  }

  // Step 4: Expand mixed alphanumeric terms (MP4 → em pee four, H264 → aitch two sixty four)
  result = result.replace(MIXED_ALPHANUM_RE, (_match, letters: string, digits: string) => {
    if (PRONOUNCEABLE_UPPERCASE.has(letters)) return _match;
    if (SPOKEN_EXPANSIONS[_match.toLowerCase()]) return result; // already handled
    const letterPart = spellOutLetters(letters);
    const numPart = expandNumber(digits);
    return `${letterPart} ${numPart}`;
  });

  // Step 4b: Expand number-first terms (4K → four kay, 3D → three dee)
  result = result.replace(NUM_ALPHA_RE, (_match, digits: string, letters: string) => {
    if (PRONOUNCEABLE_UPPERCASE.has(letters)) return _match;
    const numPart = expandNumber(digits);
    const letterPart = spellOutLetters(letters);
    return `${numPart} ${letterPart}`;
  });

  // Step 5: Convert remaining uppercase sequences (2+ letters) to phonetic form
  // unless they're in the pronounceable set or already handled
  result = result.replace(UPPERCASE_ACRONYM_RE, (match) => {
    if (PRONOUNCEABLE_UPPERCASE.has(match)) return match;
    if (SPOKEN_EXPANSIONS[match.toLowerCase()]) return match;
    return spellOutLetters(match);
  });

  // Step 6: Clean up redundant punctuation introduced by pause-tag conversion.
  result = result.replace(/([.!?;,])\s*,/g, "$1");        // punct + comma → just punct
  result = result.replace(/([.!?])\s*\.\.\./g, "$1");     // punct + ellipsis → just punct
  result = result.replace(/([.!?])\s*\.\n/g, "$1\n");     // punct + period-newline → punct-newline
  result = result.replace(/\n{2,}/g, "\n");                // collapse multiple newlines

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
