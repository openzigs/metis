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
 * The defaults were calibrated on the Phase 0 question set (#2237) and, in
 * #2417, on a second corpus and for each supported local embedder; see
 * `eval-data/README.md` > "Relevance floor (#2241)".
 */
import type { RetrievedChunk } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";

/** The config key; `0` turns the floor off. */
export const CHAT_RELEVANCE_FLOOR_KEY = "CHAT_RETRIEVAL_MIN_SCORE";

/** A calibrated default floor, and the one embedding width it holds at. */
export interface CalibratedFloor {
  floor: number;
  /**
   * Set for a model whose width `EMBED_DIM` can truncate (EmbeddingGemma's
   * Matryoshka widths): the floor holds only at this width.
   */
  dimension?: number;
}

/**
 * #2417 — the default floor on a retrieved chunk's dense cosine, per embedder:
 * for each, the highest floor that empties no answerable question on EITHER
 * `baqa-01-acme-reader` or `localization-02-fixture-portfolio` (`pnpm
 * eval:ba-qa --floor-sweep`, with `--floor-corpus` for the second; the owner's
 * rule, which accepts losing a question's weaker expected excerpts while its
 * best ones remain). Cosines sit lower on the small TypeScript services than on
 * Miniflux, so the second corpus set every floor.
 */
export const CALIBRATED_RELEVANCE_FLOORS: ReadonlyMap<string, CalibratedFloor> = new Map([
  ["Alibaba-NLP/gte-modernbert-base", { floor: 0.52 }],
  ["Xenova/bge-small-en-v1.5", { floor: 0.55 }],
  ["onnx-community/embeddinggemma-300m-ONNX", { floor: 0.6, dimension: 768 }],
]);

/** A model's calibrated floor, or `null` when it has none at the configured width. */
function calibratedFloor(model: string): number | null {
  const c = CALIBRATED_RELEVANCE_FLOORS.get(model);
  if (!c) return null;
  if (c.dimension !== undefined) {
    const dim = process.env.EMBED_DIM?.trim();
    if (dim && Number(dim) !== c.dimension) return null;
  }
  return c.floor;
}

/**
 * The floor for hits embedded by `models`, read as a decimal (`getNumber` reads
 * integers, which would turn 0.52 into 0). An operator-set value is used as
 * given, held to 0..1. When unset or unreadable a default applies only if
 * every model has one ({@link CALIBRATED_RELEVANCE_FLOORS}), and then the
 * lowest of them, so no model's evidence is held to another's scale. Any other
 * model's cosines are on an unmeasured scale (the offline hash stub's sit near
 * 0), so the floor is off (0) there rather than abstaining on answerable
 * questions.
 */
export function readRelevanceFloor(models: Iterable<string>): number {
  const raw = getConfigService().get(CHAT_RELEVANCE_FLOOR_KEY);
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  const floors = [...models].map(calibratedFloor);
  if (floors.length === 0 || floors.some((f) => f === null)) return 0;
  return Math.min(...(floors as number[]));
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
 * #2294 — what a turn's block says when the floor set aside every fresh match
 * but the excerpts the previous answer cited were carried in (#2240). The turn
 * stays grounded in those (the model is shown them, and the label counts what
 * reached the prompt), but the model is told this question's own search found
 * nothing usable, so it does not stretch the carried excerpts over it.
 */
export function carriedOnlyNote(belowFloor: number): string {
  return (
    `This question's own search found nothing relevant enough to use: the ${belowFloor} ` +
    `closest ${belowFloor === 1 ? "match was" : "matches were"} too weak. The only excerpts ` +
    `below are ones your previous answer cited. Answer from them only where they bear on this ` +
    `question; otherwise say the sources don't show this, and what is missing.`
  );
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
  const kept = hits.filter(floorKeep(hits, floor));
  return { kept, belowFloor: hits.length - kept.length };
}

/**
 * #2294 — the floor's test of one hit, as {@link applyRelevanceFloor} applies
 * it: a dense hit must reach `floor`, and a keyword-only hit is kept when some
 * hit of `pool` cleared it. Used where the floor runs before a list is cut, so
 * a weak hit's slot goes to the next one. Keeps everything when `floor` is 0.
 */
export function floorKeep<T extends FloorableHit>(
  pool: readonly T[],
  floor: number,
): (hit: T) => boolean {
  if (!(floor > 0)) return () => true;
  const clears = (h: T) => {
    const c = denseCosine(h);
    return c !== null && c >= floor;
  };
  const cleared = pool.some(clears);
  return (h) => (denseCosine(h) === null ? cleared : clears(h));
}
