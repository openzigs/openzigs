/**
 * Allowlist of vLLM-servable HuggingFace models.
 *
 * Issue #922 — the Admin UI start endpoint validates the requested model
 * against this list. Custom additions require editing this file (intentional
 * friction) so the admin API does not become a generic HuggingFace download
 * trigger.
 *
 * Format: HuggingFace repo id `org/model-name[:revision]`. Slashes, dashes,
 * dots, underscores, and a single optional `:tag` are the only legal
 * characters — anything else is rejected.
 */

export interface VllmModelEntry {
  /** HuggingFace repo id. */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Approximate weights size in GB (post-quantization). */
  approxWeightsGb: number;
  /** Quantization scheme baked into the repo. */
  quantization: "awq" | "gptq" | "fp16";
  /** True when the model fits comfortably under TP=2 on 2× 12 GB. */
  recommendedFor12GbDual: boolean;
  /** Free-form note shown next to the entry. */
  notes?: string;
}

/**
 * Curated allowlist. Order matters — the first `recommendedFor12GbDual`
 * entry is treated as the default.
 */
export const VLLM_ALLOWED_MODELS: readonly VllmModelEntry[] = [
  {
    id: "Qwen/Qwen2.5-14B-Instruct-AWQ",
    label: "Qwen2.5 14B Instruct (AWQ)",
    approxWeightsGb: 9,
    quantization: "awq",
    recommendedFor12GbDual: true,
    notes: "Default. ~9 GB weights leave headroom for KV cache on 2× 12 GB TP=2.",
  },
  {
    id: "casperhansen/gemma-2-9b-it-awq",
    label: "Gemma 2 9B Instruct (AWQ)",
    approxWeightsGb: 6,
    quantization: "awq",
    recommendedFor12GbDual: true,
    notes: "Safer fallback; smallest footprint of the allowlist.",
  },
  {
    id: "casperhansen/mistral-nemo-12b-awq",
    label: "Mistral Nemo 12B (AWQ)",
    approxWeightsGb: 8,
    quantization: "awq",
    recommendedFor12GbDual: true,
  },
  {
    id: "Qwen/Qwen2.5-32B-Instruct-AWQ",
    label: "Qwen2.5 32B Instruct (AWQ)",
    approxWeightsGb: 20,
    quantization: "awq",
    recommendedFor12GbDual: false,
    notes: "Tight on 2× 12 GB; works at 4096 ctx with mem_util ≤ 0.85.",
  },
  {
    id: "casperhansen/mixtral-8x7b-instruct-v0.1-awq",
    label: "Mixtral 8x7B Instruct (AWQ)",
    approxWeightsGb: 24,
    quantization: "awq",
    recommendedFor12GbDual: false,
    notes: "Borderline on 2× 12 GB; reduce mem_util if KV cache OOMs.",
  },
];

const ALLOWED_IDS = new Set(VLLM_ALLOWED_MODELS.map((m) => m.id));

/** Strict HuggingFace repo id pattern. Rejects path traversal and shell
 *  metacharacters before the allowlist lookup.
 *  Format: `<org>/<name>[:<revision>]`. */
const HF_REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/;

export type ModelValidationResult =
  | { ok: true; entry: VllmModelEntry }
  | { ok: false; reason: string };

/**
 * Validate a model id against the allowlist + format rules.
 *
 * Rejects:
 *   - empty / whitespace-only strings
 *   - strings containing `..`, `/..`, `\\`, null bytes, or shell metacharacters
 *   - anything that doesn't match the strict HF repo id regex
 *   - any id not in `VLLM_ALLOWED_MODELS`
 */
export function validateModelId(input: unknown): ModelValidationResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, reason: "model must be a non-empty string" };
  }
  if (input.includes("\0") || input.includes("\\") || input.includes("..")) {
    return { ok: false, reason: "model id contains forbidden characters" };
  }
  if (!HF_REPO_ID_RE.test(input)) {
    return { ok: false, reason: "model id does not match HuggingFace repo id format" };
  }
  if (!ALLOWED_IDS.has(input)) {
    return { ok: false, reason: "model id is not in the vLLM allowlist" };
  }
  const entry = VLLM_ALLOWED_MODELS.find((m) => m.id === input)!;
  return { ok: true, entry };
}

/** Default model id (first entry recommended for 2× 12 GB hosts). */
export const DEFAULT_VLLM_MODEL: string =
  VLLM_ALLOWED_MODELS.find((m) => m.recommendedFor12GbDual)?.id ??
  VLLM_ALLOWED_MODELS[0].id;
