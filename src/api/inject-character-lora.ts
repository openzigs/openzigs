/**
 * Shared helper: inject character-LoRA adapter paths into a media job
 * payload by trigger-word match (or explicit character lookup).
 *
 * Lives in its own module so:
 *   - The queue API (`/jobs`) can call it on every txt2img/img2img submission
 *   - The Creative Studio API (`/inpaint`) can call it on inpainting jobs
 *   - Both code paths share one implementation — single source of truth
 *     for trigger-word matching, multi-subject prompt restructuring, and
 *     class-description injection.
 *
 * Epic #868 — LoRA-trained character injection in the inpainting studio.
 */

import { logger } from "../logging/logger.js";
import type { CharacterRepository, CharacterProfile } from "../characters/character-repository.js";
import type { MediaJobPayload } from "../queue/types.js";

/**
 * Mutate ``payload`` in-place to add LoRA paths/scales for any "ready"
 * character whose trigger word appears in ``payload.prompt``. If the caller
 * has already set ``payload.lora_paths``, this is a no-op (explicit wins).
 *
 * Multi-subject prompts (e.g. "another dog", "two people") get an
 * enumeration cue prepended ("2 subjects: ...") and a slightly lower
 * default ``guidance_scale`` so SDXL allocates cross-attention capacity to
 * both subjects.
 */
export function injectCharacterLora(
  payload: MediaJobPayload,
  characterRepo: CharacterRepository | undefined,
): void {
  if (!characterRepo) return;
  if (payload.lora_paths && payload.lora_paths.length > 0) return;

  const prompt = String(payload.prompt ?? "");
  if (!prompt) return;

  try {
    const readyCharacters = characterRepo.getByStatus("ready");
    const loraPaths: string[] = [];
    const loraScales: number[] = [];

    for (const char of readyCharacters) {
      if (!char.trainedLoraPath || !char.triggerWord) continue;
      const regex = new RegExp(
        `\\b${char.triggerWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      );
      if (regex.test(prompt)) {
        loraPaths.push(char.trainedLoraPath);
        loraScales.push(char.loraScale);

        if (char.description) {
          const promptLower = (
            (payload.prompt as string) ?? ""
          ).toLowerCase();
          const descWords = char.description
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2);
          const descAlreadyPresent = descWords.some((w) =>
            promptLower.includes(w),
          );
          if (!descAlreadyPresent) {
            const trigRegex = new RegExp(
              `(\\b${char.triggerWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b)`,
              "i",
            );
            payload.prompt = String(payload.prompt ?? "").replace(
              trigRegex,
              `$1 ${char.description}`,
            );
            logger.info(
              `[LoRAInject] Injected class description "${char.description}" into prompt for character "${char.name}"`,
            );
          }
        }

        logger.info(
          `[LoRAInject] Auto-injecting LoRA for character "${char.name}" (trigger: ${char.triggerWord}, scale: ${char.loraScale})`,
        );
      }
    }

    if (loraPaths.length > 0) {
      payload.lora_paths = loraPaths;
      payload.lora_scales = loraScales;

      // WS3-C (#932): force the inference model to the LoRA's training base
      // model. Loading an SDXL adapter into a FLUX pipe (or vice-versa) is a
      // silent no-op at best and a crash at worst. We pick the first matched
      // character's baseModel — multi-character prompts mixing base models is
      // unsupported and emits a warning.
      const baseModels = new Set<string>();
      for (const c of readyCharacters) {
        if (
          c.baseModel &&
          loraPaths.includes(c.trainedLoraPath ?? "")
        ) {
          baseModels.add(c.baseModel);
        }
      }
      if (baseModels.size > 0) {
        const [forced] = baseModels;
        if (
          payload.model &&
          payload.model !== forced &&
          !payload.model.startsWith(forced)
        ) {
          logger.warn(
            `[LoRAInject] Caller requested model="${payload.model}" but character LoRA was trained for "${forced}" — forcing model="${forced}" to avoid silent mismatch.`,
          );
        }
        payload.model = forced;
        if (baseModels.size > 1) {
          logger.warn(
            `[LoRAInject] Multiple base models in matched characters: ${[...baseModels].join(", ")} — used "${forced}". Adapters from other base models will likely silently no-op.`,
          );
        }
      }

      const multiSubjectCues =
        /\b(another|other|two|three|second|both|together with|alongside|chasing|playing with|next to|beside|with a|and a)\b/i;
      const currentPrompt = String(payload.prompt ?? "");
      if (multiSubjectCues.test(currentPrompt)) {
        if (
          !/^\d+\s+(animal|subject|people|person|dog|cat|creature)/i.test(
            currentPrompt,
          )
        ) {
          payload.prompt = `2 subjects: ${currentPrompt}`;
        }
        const currentGuidance = payload.guidance_scale;
        if (currentGuidance === undefined || currentGuidance === null) {
          payload.guidance_scale = 6.5;
        }
        logger.info(
          `[LoRAInject] Multi-subject detected — added enumeration cue and guidance_scale=${payload.guidance_scale}`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[LoRAInject] Character LoRA auto-injection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Force-inject the LoRA for an explicitly-selected character (UI character
 * picker flow, epic #868). Unlike ``injectCharacterLora``, this does NOT
 * require a trigger-word match — the character is guaranteed to apply
 * because the user picked it.
 *
 * Returns the resolved character profile so the caller can confirm to the
 * client which character was applied (or surface a 400 when the character
 * is not "ready" / not found).
 */
export function injectExplicitCharacterLora(
  payload: MediaJobPayload,
  characterRepo: CharacterRepository,
  characterId: string,
): CharacterProfile {
  const char = characterRepo.getById(characterId);
  if (!char) {
    const err = new Error(`Character not found: ${characterId}`);
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (char.status !== "ready" || !char.trainedLoraPath) {
    const err = new Error(
      `Character "${char.name}" is not ready for inference (status=${char.status})`,
    );
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  // Replace any auto-injection from a partial trigger-word match —
  // explicit selection wins.
  payload.lora_paths = [char.trainedLoraPath];
  payload.lora_scales = [char.loraScale];

  // WS3-C (#932): pin the inference model to the LoRA's training base
  // model so an SDXL-trained adapter never silently lands inside a FLUX pipe.
  if (char.baseModel) {
    if (
      payload.model &&
      payload.model !== char.baseModel &&
      !payload.model.startsWith(char.baseModel)
    ) {
      logger.warn(
        `[LoRAInject] Caller requested model="${payload.model}" but character "${char.name}" LoRA was trained for "${char.baseModel}" — forcing model="${char.baseModel}".`,
      );
    }
    payload.model = char.baseModel;
  }

  // Inject the trigger word into the prompt if it's not already present so
  // the trained activation token actually fires during sampling.
  const prompt = String(payload.prompt ?? "");
  const trigRegex = new RegExp(
    `\\b${char.triggerWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  if (!trigRegex.test(prompt)) {
    payload.prompt = prompt
      ? `${char.triggerWord} ${prompt}`
      : char.triggerWord;
  }

  logger.info(
    `[LoRAInject] Explicit character LoRA applied: "${char.name}" (id=${char.id}, scale=${char.loraScale})`,
  );
  return char;
}
