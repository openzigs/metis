/**
 * Epic #929 / Issue #930 — pure recall/precision scorer for the Impact Analysis
 * requirement→(code, tables) eval harness.
 *
 * Given, per requirement, the tables + code symbols the REAL impact engine
 * surfaced (FOUND) and the labeled ground truth (EXPECTED), compute recall and
 * precision for BOTH dimensions plus a HIT / WRONG / MISS breakdown so precision
 * is VISIBLE, not just recall. All functions are side-effect-free set operations
 * so the unit test, the self-test synthetic fixture, and the offline CLI share
 * exactly one definition of "how good was the impact analysis".
 *
 *   recall(x)    = |found ∩ expected| / |expected|   ("of what should surface, how much did")
 *   precision(x) = |found ∩ expected| / |found|      ("of what we surfaced, how much was right")
 *
 * Empty-set convention (documented so the boundary is unambiguous, matching the
 * #738 reqmap scorer):
 *   - expected empty ⇒ recall = 1 (nothing to find ⇒ fully recalled).
 *   - found empty    ⇒ precision = 1 (nothing surfaced ⇒ nothing wrong surfaced).
 * The per-requirement HIT/WRONG/MISS lists make the raw truth visible regardless
 * of the ratio convention, so a MISS (found nothing) is never mistaken for a win.
 */
import { codeQualifiedNameSegments } from "../../code-graph/qualified-name.js";

/** Recall/precision + set breakdown for one dimension (tables OR code symbols). */
export interface SetScore {
  /** Normalized, deduped, sorted ground-truth set. */
  expected: string[];
  /** Normalized, deduped, sorted surfaced set. */
  found: string[];
  /** found ∩ expected — correctly surfaced (HIT). */
  hit: string[];
  /** found \ expected — surfaced but not expected (WRONG / over-broad). */
  wrong: string[];
  /** expected \ found — expected but missed (MISS). */
  miss: string[];
  recall: number;
  precision: number;
}

/** Per-requirement score across all dimensions. */
export interface RequirementScore {
  id: string;
  text: string;
  tables: SetScore;
  /** Null when the requirement carries no `expectedCodeSymbols` label. */
  code: SetScore | null;
  /**
   * #959 — cross-project shared-table CONSUMERS: which OTHER projects an impact
   * run should flag as touching the affected tables. Null unless the requirement
   * DECLARES the label (the `expectedConsumers` key is present, even if empty) —
   * so single-project corpora (corpus-01) emit no consumer score and stay
   * byte-identical.
   */
  consumers: SetScore | null;
}

/** Pooled recall/precision (micro) + per-requirement mean (macro) for one dimension. */
export interface DimensionAggregate {
  /** Requirements that carried a label for this dimension. */
  labeledCount: number;
  /** Mean of the per-requirement recall/precision (each requirement weighted equally). */
  macroRecall: number;
  macroPrecision: number;
  /** Pooled over all HIT/WRONG/MISS (each object weighted equally). */
  microRecall: number;
  microPrecision: number;
  /** Fraction of labeled requirements with ≥1 hit. */
  hitRate: number;
}

/** Aggregate across every requirement. */
export interface EvalAggregate {
  requirementCount: number;
  tables: DimensionAggregate;
  /** Null when NO requirement carried an `expectedCodeSymbols` label. */
  code: DimensionAggregate | null;
  /**
   * #959 — cross-project consumer dimension. The key is ABSENT (not null) when no
   * requirement declared an `expectedConsumers` label, so the serialized report of
   * a single-project corpus is byte-identical to the pre-#959 output.
   */
  consumers?: DimensionAggregate;
}

/**
 * Normalize a table identity for comparison: strip an optional `schema.` prefix
 * (the crossing may emit `<schema>.<table>` while labels are bare) and lowercase.
 */
export function normalizeTable(name: string): string {
  const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return bare.trim().toLowerCase();
}

/**
 * Normalize a code-symbol identity for comparison: reduce a fully-qualified name to
 * its simple (last) segment — labels are bare method names while the engine emits
 * fully-qualified names — and lowercase.
 *
 * #1016: the production convention (`code-graph/qualified-name.ts`) separates
 * segments with `::` and roots them at the FILE PATH, so a `.`-only reduction of
 * `persistence/AccountMapper.java::AccountMapper::getAccountByUsername` returns
 * `java::accountmapper::getaccountbyusername` — never equal to the label
 * `getAccountByUsername`, silently scoring every production-shaped symbol as a
 * MISS. The `::` separator therefore wins whenever present; the dotted fallback
 * still handles the MyBatis statement namespace (`<namespace>.<statementId>`),
 * which the schema-graph writer emits with dots.
 */
export function normalizeCodeSymbol(name: string): string {
  const segments = codeQualifiedNameSegments(name);
  const last = segments.length > 0 ? segments[segments.length - 1] : name;
  const simple = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1) : last;
  return simple.trim().toLowerCase();
}

/**
 * Normalize a consumer PROJECT identity for comparison (#959): trim + lowercase.
 * Project ids are opaque slugs (e.g. `impact-recall-02-reporting`) compared whole,
 * so — unlike tables/symbols — no dotted-segment stripping is applied.
 */
export function normalizeConsumer(projectId: string): string {
  return projectId.trim().toLowerCase();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Score one dimension: FOUND vs EXPECTED. Both are normalized+deduped by the
 * caller-supplied `normalize` fn before the set algebra so `schema.orders` and
 * `orders`, or `Mapper.getOrder` and `getOrder`, compare equal.
 */
export function scoreSet(
  foundRaw: string[],
  expectedRaw: string[],
  normalize: (s: string) => string,
): SetScore {
  const expected = dedupeSorted(expectedRaw.map(normalize).filter(Boolean));
  const found = dedupeSorted(foundRaw.map(normalize).filter(Boolean));
  const expectedSet = new Set(expected);
  const foundSet = new Set(found);

  const hit = found.filter((f) => expectedSet.has(f));
  const wrong = found.filter((f) => !expectedSet.has(f));
  const miss = expected.filter((e) => !foundSet.has(e));

  return {
    expected,
    found,
    hit,
    wrong,
    miss,
    recall: ratio(hit.length, expected.length),
    precision: ratio(hit.length, found.length),
  };
}

/** Ground-truth label + the engine's surfaced sets for one requirement. */
export interface RequirementObservation {
  id: string;
  text: string;
  expectedTables: string[];
  foundTables: string[];
  /** Undefined/empty ⇒ this requirement is not scored for code (tables are primary). */
  expectedCodeSymbols?: string[];
  foundCodeSymbols: string[];
  /**
   * #959 — the OTHER projects an impact run should flag as consumers of the
   * affected shared tables. The requirement is consumer-scored iff this key is
   * PRESENT (even as `[]`, which asserts "no cross-project consumer"); `undefined`
   * ⇒ not scored (single-project requirement). Distinguishing present-empty from
   * absent is what keeps corpus-01 byte-identical.
   */
  expectedConsumers?: string[];
  /** Consumer projects the harness surfaced (empty at baseline — see runner). */
  foundConsumers?: string[];
}

/** Score one requirement across all labeled dimensions. */
export function scoreRequirement(obs: RequirementObservation): RequirementScore {
  const tables = scoreSet(obs.foundTables, obs.expectedTables, normalizeTable);
  const hasCodeLabel = (obs.expectedCodeSymbols?.length ?? 0) > 0;
  const code = hasCodeLabel
    ? scoreSet(obs.foundCodeSymbols, obs.expectedCodeSymbols ?? [], normalizeCodeSymbol)
    : null;
  // Presence of the KEY (not a non-empty value) declares the consumer label, so a
  // requirement can assert "no consumers" (`[]`) and still be scored for precision.
  const hasConsumerLabel = obs.expectedConsumers !== undefined;
  const consumers = hasConsumerLabel
    ? scoreSet(obs.foundConsumers ?? [], obs.expectedConsumers ?? [], normalizeConsumer)
    : null;
  return { id: obs.id, text: obs.text, tables, code, consumers };
}

function aggregateDimension(scores: SetScore[]): DimensionAggregate {
  const n = scores.length;
  if (n === 0) {
    return {
      labeledCount: 0,
      macroRecall: 0,
      macroPrecision: 0,
      microRecall: 0,
      microPrecision: 0,
      hitRate: 0,
    };
  }
  const mean = (pick: (s: SetScore) => number): number =>
    scores.reduce((sum, s) => sum + pick(s), 0) / n;

  const totalHit = scores.reduce((sum, s) => sum + s.hit.length, 0);
  const totalExpected = scores.reduce((sum, s) => sum + s.expected.length, 0);
  const totalFound = scores.reduce((sum, s) => sum + s.found.length, 0);

  return {
    labeledCount: n,
    macroRecall: mean((s) => s.recall),
    macroPrecision: mean((s) => s.precision),
    microRecall: ratio(totalHit, totalExpected),
    microPrecision: ratio(totalHit, totalFound),
    hitRate: scores.filter((s) => s.hit.length > 0).length / n,
  };
}

/** Aggregate per-requirement scores into per-dimension macro/micro/hit-rate. */
export function aggregateScores(scores: RequirementScore[]): EvalAggregate {
  const tableScores = scores.map((s) => s.tables);
  const codeScores = scores.map((s) => s.code).filter((c): c is SetScore => c !== null);
  const consumerScores = scores.map((s) => s.consumers).filter((c): c is SetScore => c !== null);
  const aggregate: EvalAggregate = {
    requirementCount: scores.length,
    tables: aggregateDimension(tableScores),
    code: codeScores.length > 0 ? aggregateDimension(codeScores) : null,
  };
  // Only attach the consumers key when a requirement declared the label — the
  // single-project (corpus-01) path never sets it, keeping the report identical.
  if (consumerScores.length > 0) {
    aggregate.consumers = aggregateDimension(consumerScores);
  }
  return aggregate;
}
