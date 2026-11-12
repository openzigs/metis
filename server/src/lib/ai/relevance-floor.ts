/**
 * #2241 — chat's relevance floor on automatic retrieval.
 *
 * Before #2241 every chat turn got the knowledge search's top 8 chunks however
 * weakly they matched, and the reply was labelled "Grounded · 8 sources" even
 * when none of them bore on the question. The floor drops a retrieved chunk
 * whose dense cosine is below it, so a turn whose question the project's
 * sources do not touch reaches the model with no excerpts — and the
 * "insufficient evidence" outcome is decided here, in code, not left to the
 * model's reading of eight unrelated excerpts.
 *
 * The floor reads the dense cosine (`denseScore`, else `score`), never the
 * rank score: a fused or reranked rank says how a hit placed against the
 * others, not whether any of them is relevant. A hit only the keyword search
 * found has no cosine; it is kept when at least one dense hit cleared the
 * floor (the question is about this project and the keyword match supports
 * it), and dropped with the rest otherwise.
 *
 * The default was calibrated on the Phase 0 question set (#2237); see
 * `eval-data/README.md` > "Relevance floor (#2241)".
 */
import type { RetrievedChunk } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { COSINE_CALIBRATED_MODELS } from "../traceability/requirement-code-mapping.js";

/** The config key; `0` turns the floor off. */
export const CHAT_RELEVANCE_FLOOR_KEY = "CHAT_RETRIEVAL_MIN_SCORE";

/**
 * The default floor on a retrieved chunk's dense cosine (gte-modernbert-base,
 * the default embedder). Calibrated on `baqa-01-acme-reader` (#2241).
 */
export const DEFAULT_CHAT_RELEVANCE_FLOOR = 0.55;

/**
 * The floor for hits embedded by `models`, read as a decimal (`getNumber` reads
 * integers, which would turn 0.55 into 0). An operator-set value is used as
 * given, held to 0..1. When unset or unreadable the default applies only if
 * every model is one whose cosines the default was calibrated on
 * ({@link COSINE_CALIBRATED_MODELS}); another model's cosines are on another
 * scale (the offline hash stub's sit near 0), so the floor is off (0) there
 * rather than abstaining on answerable questions.
 */
export function readRelevanceFloor(models: Iterable<string>): number {
  const raw = getConfigService().get(CHAT_RELEVANCE_FLOOR_KEY);
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  const used = [...models];
  const calibrated = used.length > 0 && used.every((m) => COSINE_CALIBRATED_MODELS.has(m));
  return calibrated ? DEFAULT_CHAT_RELEVANCE_FLOOR : 0;
}

type FloorableHit = Pick<RetrievedChunk, "score" | "denseScore" | "matchedBy">;

/** A hit's dense cosine, or `null` when only the keyword search found it. */
export function denseCosine(hit: FloorableHit): number | null {
  if (hit.matchedBy && !hit.matchedBy.includes("dense")) return null;
  return hit.denseScore ?? hit.score;
}

export interface FloorResult<T> {
  /** The hits that cleared the floor, in their original order. */
  kept: T[];
  /** How many retrieved hits the floor dropped. */
  belowFloor: number;
}

/**
 * Keep the hits whose dense cosine is at least `floor`, and the keyword-only
 * hits when any dense hit cleared it. A `floor` of 0 or less keeps every hit.
 */
export function applyRelevanceFloor<T extends FloorableHit>(
  hits: readonly T[],
  floor: number,
): FloorResult<T> {
  if (!(floor > 0)) return { kept: [...hits], belowFloor: 0 };
  const cleared = hits.some((h) => {
    const c = denseCosine(h);
    return c !== null && c >= floor;
  });
  const kept = hits.filter((h) => {
    const c = denseCosine(h);
    return c === null ? cleared : c >= floor;
  });
  return { kept, belowFloor: hits.length - kept.length };
}
