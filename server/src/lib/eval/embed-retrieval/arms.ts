/**
 * Epic #780 / Issue #788 — the arms under test.
 *
 * The decision-relevant comparison is NOT "hash vs gte-modernbert" (the issue
 * text's original framing): the hash embedder is chance-level, so beating it
 * proves nothing about whether the flip is worth doing. The INCUMBENT is the
 * model that is actually the default today — `Xenova/bge-small-en-v1.5`
 * (384-d, mean pooling, q8; see `DEFAULT_SIDECAR_EMBED_MODEL` in
 * `embed-model-config.ts`). Hash is kept only as a chance-level FLOOR that
 * proves the eval can see semantics at all.
 *
 * Every arm is built through the PRODUCTION {@link Embedder} entry point with an
 * explicit backend/model/pooling/dtype, so the vectors scored here are produced
 * by the same code path that writes vectors in production.
 */
import { Embedder } from "../../rag/embedder.js";
import {
  AIR_GAP_EMBED_MODEL,
  BGE_SMALL_EMBED_MODEL,
  type EmbedDtype,
  type EmbedPooling,
} from "../../rag/embed-model-config.js";
import type { EmbedFn } from "./runner.js";
import type { ArmRole } from "./verdict.js";

/** Model id the hash floor arm reports (the deterministic offline stub). */
export const HASH_MODEL = "metis-offline-hash-v1";

export interface ArmSpec {
  id: string;
  role: ArmRole;
  label: string;
  /** Registry backend key: `xenova` (real ONNX weights) or `offline` (hash stub). */
  backend: "xenova" | "offline";
  model: string;
  dimension: number;
  pooling?: EmbedPooling;
  dtype?: EmbedDtype;
  /** Whether running this arm downloads or loads real model weights. */
  requiresWeights: boolean;
  /** Why this arm exists in the decision. */
  rationale: string;
}

export const ARMS: readonly ArmSpec[] = [
  {
    id: "A-incumbent-bge-mean-q8",
    role: "incumbent",
    label: "bge-small-en-v1.5 · 384d · mean · q8",
    backend: "xenova",
    model: BGE_SMALL_EMBED_MODEL,
    dimension: 384,
    pooling: "mean",
    dtype: "q8",
    requiresWeights: true,
    rationale: "The model that is the default TODAY. The flip must beat this, not the hash stub.",
  },
  {
    id: "B-candidate-gte-cls-q8",
    role: "candidate",
    label: "gte-modernbert-base · 768d · cls · q8",
    backend: "xenova",
    model: AIR_GAP_EMBED_MODEL,
    dimension: 768,
    pooling: "cls",
    dtype: "q8",
    requiresWeights: true,
    rationale: "The model #783 proposes to flip to, with the pooling #782 mapped for it.",
  },
  {
    id: "C-trap-gte-mean-q8",
    role: "wrong-pooling",
    label: "gte-modernbert-base · 768d · MEAN (deliberately wrong) · q8",
    backend: "xenova",
    model: AIR_GAP_EMBED_MODEL,
    dimension: 768,
    pooling: "mean",
    dtype: "q8",
    requiresWeights: true,
    rationale:
      "The validity check. #782 measured cosine(cls, mean) = 0.856 on this model — wrong-pooled " +
      "vectors are unit-norm, finite and plausible. If the eval cannot score this arm WORSE than " +
      "arm B, it cannot detect the epic's biggest risk and its verdict means nothing.",
  },
  {
    id: "D-candidate-gte-cls-fp32",
    role: "candidate-fp32",
    label: "gte-modernbert-base · 768d · cls · fp32",
    backend: "xenova",
    model: AIR_GAP_EMBED_MODEL,
    dimension: 768,
    pooling: "cls",
    dtype: "fp32",
    requiresWeights: true,
    rationale: "Answers the fp32-vs-q8 quality question #782 explicitly deferred to #788.",
  },
  {
    id: "E-floor-hash",
    role: "hash-floor",
    label: "metis-offline-hash-v1 · 384d (chance-level floor)",
    backend: "offline",
    model: HASH_MODEL,
    dimension: 384,
    requiresWeights: false,
    rationale:
      "Chance-level floor. Not the baseline the verdict rests on — only proof that the corpus + " +
      "metric can distinguish semantics from deterministic noise.",
  },
];

/** Look an arm up by role. Throws on an unknown role (no silent nulls). */
export function armByRole(role: ArmRole): ArmSpec {
  const spec = ARMS.find((a) => a.role === role);
  if (!spec) throw new Error(`No arm defined for role "${role}"`);
  return spec;
}

/**
 * Build the {@link EmbedFn} for an arm using the production `Embedder`. The
 * `xenova` arms load real ONNX weights on first call (network or a warm
 * `TRANSFORMERS_CACHE`); the `offline` arm is pure local hashing.
 */
export function createArmEmbedFn(spec: ArmSpec): EmbedFn {
  const embedder = new Embedder({
    backend: spec.backend,
    model: spec.model,
    dimension: spec.dimension,
    pooling: spec.pooling,
    dtype: spec.dtype,
  });
  return async (texts: string[]) => {
    const result = await embedder.embed(texts);
    return result.vectors;
  };
}
