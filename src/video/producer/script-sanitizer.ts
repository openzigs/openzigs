/**
 * Script Sanitizer — Issue #271 (SI-3)
 *
 * Narration scripts pass through this module before being sent to TTS synthesis.
 * Defends against prompt injection: an attacker embedding instructions inside a
 * video script that could hijack downstream LLM calls or exfiltrate data.
 *
 * Threat model:
 *   Attacker-controlled text (from user input, file uploads, web scraping, etc.)
 *   may contain:
 *     1. System directive headers: "SYSTEM:", "<|system|>", "[SYSTEM]", etc.
 *     2. Ignore/jailbreak instructions: "Ignore previous instructions...",
 *        "Disregard your prompt...", etc.
 *     3. Escaped tool call JSON blobs injected mid-paragraph.
 *     4. Markdown code fences with shell/SQL commands.
 *     5. Shell meta-characters that could be misinterpreted by a downstream TTS
 *        subprocess call (;, |, &&, $(), etc.).
 *     6. HTML/XML tags that could inject content into rendered templates.
 *
 * Strategy:
 *   - Detect and redact high-confidence injection patterns.
 *   - Strip structural markup not meaningful in spoken narration.
 *   - Normalize whitespace for clean TTS input.
 *   - Return a detailed result so callers can log or reject flagged text.
 *
 * This module is intentionally side-effect free and has zero external imports.
 * It MUST NOT import SQLite, LLM clients, or agent orchestration modules.
 */

export interface SanitizationResult {
  /** The sanitized text — safe to pass to TTS. */
  text: string;
  /** True if at least one suspicious pattern was found and redacted. */
  flagged: boolean;
  /** Human-readable list of detected threat categories. */
  threats: string[];
}

// ── Pattern Definitions ──────────────────────────────────────────────────────

/**
 * System-prompt header patterns (case-insensitive).
 *
 * Matches lines that open with a system-role directive, which an attacker
 * would use to override the model's behavior on re-ingestion.
 */
const SYSTEM_HEADER_RE = /^(system|<\|system\|>|\[system\]|###\s*system|<system>)[:\s]/im;

/**
 * Ignore / jailbreak instruction phrases.
 *
 * These phrases signal intent to override earlier instructions.
 * We replace the entire sentence that contains them.
 */
const IGNORE_INSTRUCTION_PHRASES: ReadonlyArray<RegExp> = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions?|directives?|prompts?|context)/i,
  /disregard\s+(?:(?:all|previous|prior|earlier|above|your|any|these|those)\s+)*(instructions?|directives?|prompts?|guidelines?|system\s+prompt)/i,
  /forget\s+(everything|all)\s+(you\s+)?(were\s+)?(told|trained|given|instructed)/i,
  /override\s+(your\s+)?(previous\s+)?(instructions?|system\s+prompt|guidelines?)/i,
  /new\s+instructions?:\s*from\s+now\s+on/i,
  /you\s+are\s+now\s+(a\s+)?(?:jailbroken|dan|uncensored|unrestricted)/i,
  /act\s+as\s+(if\s+you\s+are\s+)?(a\s+)?(?:jailbroken|uncensored|unrestricted|evil)/i,
  /do\s+anything\s+now/i,
];

/**
 * Tool call JSON blob detector.
 *
 * GPT-style tool calls look like {"type":"function","function":{...}}
 * or claude-style <function_calls>...</function_calls>.
 * Strip both forms.
 */
const TOOL_CALL_JSON_RE =
  /\{[\s\S]{0,20}"(?:type"\s*:\s*"function|function_call|tool_call|name"\s*:\s*"[a-zA-Z_])/g;
const TOOL_CALL_XML_RE = /<(?:function_calls?|invoke|tool_use|tool_result)[^>]*>[\s\S]*?<\/(?:function_calls?|invoke|tool_use|tool_result)>/gi;

/**
 * Markdown code fence stripper.
 *
 * ```bash\nrm -rf /\n``` has no place in narration.
 * Also strips inline backtick code spans longer than 60 chars
 * (short spans like `foo` are left to preserve natural speech).
 */
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const LONG_INLINE_CODE_RE = /`[^`]{61,}`/g;

/** Simplified shell operator escape — replace unquoted ; | && || ;; with commas or spaces. */
const SHELL_OPERATORS_RE = /(?<!\w)(;{1,2}|\|\||&&|\|(?!\w))(?!\w)/g;

/**
 * HTML / XML tag stripper.
 *
 * Tags like <script>, <iframe>, or injected prompts wrapped in XML are
 * semantically meaningless in spoken voice output and potentially dangerous.
 */
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;

/**
 * Prompt injection scaffolding patterns (common red-team formats).
 */
const INJECTION_SCAFFOLD_RE =
  /(\[INST\]|\[\/INST\]|<s>|<\/s>|<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|<\|user\|>|<\|assistant\|>)/gi;

// ── Sanitizer ────────────────────────────────────────────────────────────────

/**
 * Sanitize a narration script by detecting and removing prompt-injection patterns.
 *
 * @param raw - The raw script text from user input, file upload, or LLM output.
 * @returns SanitizationResult with cleaned text and threat metadata.
 */
export function sanitizeNarrationScript(raw: string): SanitizationResult {
  if (typeof raw !== "string") {
    return { text: "", flagged: true, threats: ["invalid_input_type"] };
  }

  const threats: string[] = [];
  let text = raw;

  // 1. System prompt headers (strip the entire line)
  if (SYSTEM_HEADER_RE.test(text)) {
    threats.push("system_header");
    text = text.replace(/^.*(?:system\s*:|<\|system\|>|\[system\]|###\s*system|<system>).*/im, "[REDACTED]");
  }

  // 2. Ignore / jailbreak instruction phrases (replace the containing sentence)
  for (const pattern of IGNORE_INSTRUCTION_PHRASES) {
    if (pattern.test(text)) {
      threats.push("ignore_instruction");
      // Replace sentence containing the pattern (up to next period, newline, or end)
      text = text.replace(
        new RegExp(`[^.!?\\n]*${pattern.source}[^.!?\\n]*[.!?]?`, pattern.flags),
        "[REDACTED]",
      );
    }
  }

  // 3. Tool call JSON blobs
  if (TOOL_CALL_JSON_RE.test(text) || TOOL_CALL_XML_RE.test(text)) {
    threats.push("tool_call_injection");
    TOOL_CALL_JSON_RE.lastIndex = 0;
    // Use nested-brace matching to replace the entire JSON object, not just the prefix
    text = text.replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, (match) => {
      TOOL_CALL_JSON_RE.lastIndex = 0;
      return TOOL_CALL_JSON_RE.test(match) ? "[REDACTED]" : match;
    });
    TOOL_CALL_JSON_RE.lastIndex = 0;
    TOOL_CALL_XML_RE.lastIndex = 0;
    text = text.replace(TOOL_CALL_XML_RE, "[REDACTED]");
    TOOL_CALL_XML_RE.lastIndex = 0;
  }

  // 4. Markdown code fences
  if (CODE_FENCE_RE.test(text)) {
    threats.push("code_fence");
    CODE_FENCE_RE.lastIndex = 0;
    text = text.replace(CODE_FENCE_RE, "[REDACTED]");
  }

  // 5. Long inline code spans
  if (LONG_INLINE_CODE_RE.test(text)) {
    threats.push("inline_code");
    LONG_INLINE_CODE_RE.lastIndex = 0;
    text = text.replace(LONG_INLINE_CODE_RE, "[REDACTED]");
  }

  // 6. Shell meta-characters (escape, do not strip)
  // Only flag backtick spans that contain whitespace AND a shell-special character
  // (e.g. `rm -rf /`). Simple spans like `Enter` or `Ctrl+C` are idiomatic narration.
  if (/\$[({]/.test(text) || /`[^`]*\s[^`]*[\/\\$><|;&*!][^`]*`/.test(text)) {
    threats.push("shell_metachar");
    // Escape only backtick spans with internal whitespace + shell chars; preserve clean spans
    text = text.replace(/`([^`]+)`/g, (match, inner) =>
      /\s/.test(inner) && /[\/\\$><|;&*!]/.test(inner) ? `'${inner}'` : match
    );
    text = text
      .replace(/\$\(([^)]*)\)/g, "($1)") // $() → ()
      .replace(/\$\{([^}]*)\}/g, "{$1}"); // ${} → {}
  }

  // 7. Shell pipe / semicolon operators (replace with comma)
  if (SHELL_OPERATORS_RE.test(text)) {
    threats.push("shell_operator");
    SHELL_OPERATORS_RE.lastIndex = 0;
    text = text.replace(SHELL_OPERATORS_RE, ",");
  }

  // 8. HTML / XML tags
  if (HTML_TAG_RE.test(text)) {
    threats.push("html_tag");
    HTML_TAG_RE.lastIndex = 0;
    text = text.replace(HTML_TAG_RE, "");
  }

  // 9. LLM scaffolding tokens
  if (INJECTION_SCAFFOLD_RE.test(text)) {
    threats.push("llm_scaffold_token");
    INJECTION_SCAFFOLD_RE.lastIndex = 0;
    text = text.replace(INJECTION_SCAFFOLD_RE, "");
  }

  // Normalize whitespace: collapse multiple blank lines, trim
  text = text
    .replace(/\n{3,}/g, "\n\n") // max 2 consecutive newlines
    .replace(/[ \t]+$/gm, "")   // trailing whitespace per line
    .trim();

  return {
    text,
    flagged: threats.length > 0,
    threats,
  };
}
