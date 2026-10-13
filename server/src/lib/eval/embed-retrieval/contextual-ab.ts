/**
 * Epic #1068 / Issue #1072 — the contextual-document A/B: do a symbol's search
 * documents retrieve better when they carry its signature, doc comment,
 * receiver, package, callers and tables?
 *
 * ## This file is the PRE-REGISTRATION
 *
 * Everything in the first half of this file — the bars, the arms, and the rule
 * that turns measured comparisons into a ship decision — was committed before
 * any arm was scored. `docs/decisions/0020-contextual-symbol-documents.md`
 * states the same in prose and names the commit. The rule is a function
 * ({@link decideContextualShip}) rather than a paragraph so that it is applied
 * mechanically to whatever comes out.
 *
 * ## The decision rule is IMPORTED, not re-derived
 *
 * `classifyDelta` and `testsAgree` are #1157's rule as `rerank-sweep.ts`
 * implements it and `interval-report.ts` prints it: the paired bootstrap CI and
 * the exact sign test, three classes. Nothing here changes it. One thing is
 * added on top, because `classifyDelta` is direction-blind: a delta whose CI
 * lies wholly BELOW zero also classifies `DIRECTION-ESTABLISHED-MAGNITUDE-NOT`.
 * {@link isEstablishedGain} therefore also requires the mean delta to be
 * positive.
 */
import { MIN_IMPORTANT_BM25_DELTA, MIN_IMPORTANT_FUSED_DELTA } from "./lexical-ab.js";
import type { RerankVerdict as DeltaVerdict } from "./rerank-sweep.js";

/** Rank depth every arm is scored at — the `@10` in nDCG@10. */
export const CONTEXTUAL_K = 10;

/**
 * PRE-REGISTERED bar for the DECISION channel: fused at `DEFAULT_WEIGHTS`
 * (`0.05 / 0.95`), rerank off, the production embedder.
 *
 * It is #1159's fused bar, reused unchanged: `0.02` is the bottom of the band
 * epic #1156 says a retrieval sub-issue moves nDCG@10 by, and below it that
 * epic treats a move as noise. The baseline it is measured against is 0.276
 * (ADR 0005, `embedretrieval-02-nl-to-code`, n = 127).
 */
export const MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA = MIN_IMPORTANT_FUSED_DELTA;

/**
 * PRE-REGISTERED bar for the pure-BM25 channel (`1.00 / 0.00`). Reported for
 * attribution; it does not decide. #1159's BM25 bar, reused unchanged.
 */
export const MIN_IMPORTANT_CONTEXTUAL_BM25_DELTA = MIN_IMPORTANT_BM25_DELTA;

/**
 * Which fields one document of an arm carries.
 *
 *  - `base` — the document `main` builds today: BM25 `name + qualifiedName`;
 *    embedding text `{kind} {name} in {filePath}` plus the first ten body lines.
 *  - `own`  — `base` plus the OWN-FILE fields: signature, doc comment, receiver,
 *    package.
 *  - `full` — `own` plus the CROSS-FILE fields: caller names and tables.
 */
export type DocumentVariant = "base" | "own" | "full";

/** One arm: which variant its BM25 document is, and which its embedding text is. */
export interface ContextualArmSpec {
  id: ContextualArmId;
  label: string;
  lexical: DocumentVariant;
  embedding: DocumentVariant;
}

export type ContextualArmId =
  "baseline" | "contextual" | "lexical-cross" | "own-file" | "lexical-only" | "vector-only";

/**
 * The six arms. Same corpus, same queries, same embedder, same weights, rerank
 * off — the documents are the only free variable.
 *
 * `contextual` is the PRIMARY treatment and the only arm that can open the
 * gate. `lexical-cross` and `own-file` are cheaper documents that may be
 * shipped INSTEAD of it (see {@link decideContextualShip}). `lexical-only` and
 * `vector-only` exist to attribute an effect to one channel and decide nothing.
 */
export const CONTEXTUAL_ARMS: readonly ContextualArmSpec[] = [
  {
    id: "baseline",
    label: "baseline — the documents main builds",
    lexical: "base",
    embedding: "base",
  },
  {
    id: "contextual",
    label: "PRIMARY — every field in both documents",
    lexical: "full",
    embedding: "full",
  },
  {
    id: "lexical-cross",
    label: "cross-file fields in the BM25 document only",
    lexical: "full",
    embedding: "own",
  },
  {
    id: "own-file",
    label: "own-file fields only, in both documents",
    lexical: "own",
    embedding: "own",
  },
  {
    id: "lexical-only",
    label: "attribution — BM25 document changed, embedding text as main",
    lexical: "full",
    embedding: "base",
  },
  {
    id: "vector-only",
    label: "attribution — embedding text changed, BM25 document as main",
    lexical: "base",
    embedding: "full",
  },
];

/**
 * The arms that may ship, CHEAPEST FIRST.
 *
 * Cost is what the documents oblige the index to do, not how long they are:
 *
 *  - `own-file` — a symbol's documents change only when its own file does.
 *  - `lexical-cross` — the BM25 document also reads call and lineage edges. It
 *    is rebuilt in memory when the symbol set is loaded, so nothing is stored
 *    that could go stale and nothing is re-embedded.
 *  - `contextual` — the EMBEDDING TEXT reads those edges too, so a symbol is
 *    re-embedded when a file that does not declare it gains or loses a caller.
 */
export const SHIPPABLE_ARMS_CHEAPEST_FIRST: readonly ContextualArmId[] = [
  "own-file",
  "lexical-cross",
  "contextual",
];

/** The minimum a comparison has to say for the rule below to read it. */
export interface DecisionInput {
  verdict: DeltaVerdict;
  meanDelta: number;
}

/**
 * `SHIP` or `DIRECTION-ESTABLISHED-MAGNITUDE-NOT`, AND pointing up.
 *
 * `classifyDelta` returns `DIRECTION-ESTABLISHED-MAGNITUDE-NOT` for a CI that
 * excludes zero on either side, so the sign is checked here.
 */
export function isEstablishedGain(c: DecisionInput): boolean {
  return c.verdict !== "NOT-ESTABLISHED" && c.meanDelta > 0;
}

/** What {@link decideContextualShip} reads, all on the fused decision channel. */
export interface ShipDecisionInput {
  /** Each shippable arm against `baseline`. */
  vsBaseline: Readonly<Record<"own-file" | "lexical-cross" | "contextual", DecisionInput>>;
  /**
   * Each costlier arm against each cheaper one, keyed `"<costlier> vs <cheaper>"`
   * ({@link incrementKey}). The arm that is named first is the one whose delta
   * is positive when it scores higher.
   */
  increments: Readonly<Record<string, DecisionInput>>;
}

export interface ShipDecision {
  /** The documents that ship, or `none`. */
  ship: ContextualArmId | "none";
  /** One sentence per step taken, in order — printed into the artifact. */
  reasons: string[];
}

/** The key of one "costlier vs cheaper" comparison in {@link ShipDecisionInput.increments}. */
export function incrementKey(costlier: ContextualArmId, cheaper: ContextualArmId): string {
  return `${costlier} vs ${cheaper}`;
}

/**
 * THE PRE-REGISTERED RULE.
 *
 * 1. **The gate is the primary treatment.** If `contextual` against `baseline`
 *    is not an established gain on the fused channel, NOTHING ships — also when
 *    a cheaper arm happens to classify as one. Three shippable arms are three
 *    chances at a false positive; only the arm named in advance may open the
 *    gate. A cheaper arm that looks good behind a closed gate is a finding for
 *    a follow-up with its own pre-registration.
 * 2. **Past the gate, the cheapest sufficient documents ship.** Walk the
 *    shippable arms cheapest first and take the first one that (a) is itself an
 *    established gain against `baseline` and (b) is not beaten, as an
 *    established gain, by any costlier shippable arm. `contextual` always
 *    satisfies both once the gate is open, so the walk ends there at the
 *    latest. This is what stops cross-file fields — which cost re-embedding and
 *    a staleness hazard — from shipping on the strength of own-file fields.
 *
 * Not inputs, on purpose: the pure-BM25 and pure-vector channels, the
 * `lexical-only` and `vector-only` arms, and the exact-name miss sets. They are
 * reported, the miss sets by name, and the reviewer reads them.
 */
export function decideContextualShip(input: ShipDecisionInput): ShipDecision {
  const reasons: string[] = [];
  if (!isEstablishedGain(input.vsBaseline.contextual)) {
    reasons.push(
      `contextual vs baseline is ${input.vsBaseline.contextual.verdict} ` +
        `(mean delta ${signed(input.vsBaseline.contextual.meanDelta)}): the gate is closed, nothing ships.`,
    );
    return { ship: "none", reasons };
  }
  reasons.push(
    `contextual vs baseline is ${input.vsBaseline.contextual.verdict} ` +
      `(mean delta ${signed(input.vsBaseline.contextual.meanDelta)}): the gate is open.`,
  );

  const arms = SHIPPABLE_ARMS_CHEAPEST_FIRST;
  for (const [i, arm] of arms.entries()) {
    const own = input.vsBaseline[arm as keyof ShipDecisionInput["vsBaseline"]];
    if (!isEstablishedGain(own)) {
      reasons.push(`${arm} vs baseline is ${own.verdict}: not sufficient on its own.`);
      continue;
    }
    const beatenBy = arms.slice(i + 1).find((costlier) => {
      const inc = input.increments[incrementKey(costlier, arm)];
      return inc !== undefined && isEstablishedGain(inc);
    });
    if (beatenBy) {
      reasons.push(`${arm} is an established gain, but ${beatenBy} is established better.`);
      continue;
    }
    reasons.push(
      `${arm} is an established gain and no costlier arm is established better: it ships.`,
    );
    return { ship: arm, reasons };
  }
  // Unreachable while `contextual` is the last shippable arm: it passed the gate
  // above and has no costlier arm to be beaten by. Kept so a reordering of
  // SHIPPABLE_ARMS_CHEAPEST_FIRST fails closed.
  reasons.push("no shippable arm qualified.");
  return { ship: "none", reasons };
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}
