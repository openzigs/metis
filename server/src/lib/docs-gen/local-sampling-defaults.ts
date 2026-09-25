/**
 * #177 — default sampling for LOCAL docs-gen, chosen per model family.
 *
 * `docsGenTuning("local")` used to apply Google's Gemma 4 model-card values
 * (temperature 1.0, top_p 0.95) to EVERY local model. Those values are right
 * for Gemma: its model card mandates them, and lower temperatures made Gemma 4's
 * MoE routing over-activate thinking and return empty content. For other models
 * they are poor: an independent evaluation measured temperature 0.2 as the best
 * Phase-1 extraction setting on laguna-s-2.1, where 1.0 had been in use.
 *
 * So Gemma keeps its model-card values and every other (or unknown) model gets
 * a conservative extraction setting. These are DEFAULTS only —
 * `DOCS_GEN_LOCAL_TEMPERATURE` / `DOCS_GEN_LOCAL_TOP_P` still override them.
 *
 * Kept in its own module so the family table can grow without touching the
 * synthesizer.
 */

export interface LocalSamplingDefaults {
  temperature: number;
  topP: number;
}

/** Gemma 3/4 model-card values. */
export const GEMMA_LOCAL_SAMPLING: Readonly<LocalSamplingDefaults> = Object.freeze({
  temperature: 1.0,
  topP: 0.95,
});

/** Conservative extraction setting for every non-Gemma or unknown local model. */
export const CONSERVATIVE_LOCAL_SAMPLING: Readonly<LocalSamplingDefaults> = Object.freeze({
  temperature: 0.2,
  topP: 0.95,
});

/**
 * Default `temperature` / `top_p` for a local model id. Matches the family on
 * the model NAME the runtime serves (`gemma4:12b`, `google/gemma-3-27b-it`,
 * `hf.co/…/Gemma-4-…`); anything else, including an empty id, is treated as
 * unknown and gets {@link CONSERVATIVE_LOCAL_SAMPLING}.
 */
export function localSamplingDefaults(model: string): LocalSamplingDefaults {
  const family = /gemma/i.test(model) ? GEMMA_LOCAL_SAMPLING : CONSERVATIVE_LOCAL_SAMPLING;
  return { ...family };
}
