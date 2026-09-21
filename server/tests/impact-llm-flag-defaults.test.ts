/**
 * Issue #1025 — the impact-analysis flag DEFAULT MATRIX, pinned in one place.
 *
 * Each stage's own test file exercises its flag reader in the context of that
 * stage. This file exists for a different reason: the *relationship* between the
 * defaults is the decision #1025 made, and that decision is invisible if it is
 * only ever spread across six files.
 *
 * The decision:
 *
 *   - The four ENRICHMENT stages default **ON**. Deterministic-only output is
 *     measurably poor for a business analyst (macro table precision 0.4636 vs
 *     0.7803 with the relevance filter; ZERO actionable `ALTER TABLE … ADD
 *     COLUMN` rows vs 2 per requirement; no per-table rationale; no
 *     incompleteness advisory).
 *   - `IMPACT_LLM_ENTITY_SEEDS` defaults **OFF**. It is the one stage with a
 *     MEASURED COST — macro table precision 0.7626 → 0.6909, lower in 34 of 34
 *     pairwise comparisons on non-overlapping spreads — and in the live
 *     walkthrough it still did not surface `account`, the miss it exists to fix.
 *   - `IMPACT_LLM_SEEDING` (#931) stays **OFF**: it regressed table precision
 *     0.42 → 0.29 by scoring its own picks 1.0 and the deterministic top-K 0.2.
 *
 * And the invariant that survives the flip: **every flag is still a kill-switch.**
 * Default-ON stages cost real money on every analysis (~$0.051 and ~18 s for a
 * single-requirement run against `claude-sonnet-5`), so `=0` / `=false` must
 * disable each one independently. A default that cannot be turned off is not a
 * default, it is a hard-coding.
 */
import { describe, expect, it } from "vitest";
import { impactLlmTableFilterEnabled } from "../src/lib/impact-analysis/table-relevance-filter.js";
import { impactLlmAdditiveDdlEnabled } from "../src/lib/impact-analysis/additive-column-proposer.js";
import { impactLlmClauseReconcileEnabled } from "../src/lib/impact-analysis/clause-coverage-reconciler.js";
import { impactLlmSummaryEnabled } from "../src/lib/impact-analysis/impact-summarizer.js";
import { impactLlmTableJudgeEnabled } from "../src/lib/impact-analysis/table-relevance-judge.js";
import { impactLlmEntitySeedsEnabled } from "../src/lib/traceability/requirement-entity-seeds.js";
import {
  impactLlmSeedingEnabled,
  requirementQueryDenoiseEnabled,
} from "../src/lib/traceability/requirement-code-mapping.js";

type FlagReader = (env: NodeJS.ProcessEnv) => boolean;

interface FlagCase {
  /** Environment variable name — the thing an operator actually sets. */
  readonly name: string;
  readonly read: FlagReader;
  /** What an install that sets nothing gets. */
  readonly defaultsOn: boolean;
}

/** The default-ON enrichment stages flipped by #1025. */
const DEFAULT_ON: readonly FlagCase[] = [
  { name: "IMPACT_LLM_TABLE_FILTER", read: impactLlmTableFilterEnabled, defaultsOn: true },
  { name: "IMPACT_LLM_ADDITIVE_DDL", read: impactLlmAdditiveDdlEnabled, defaultsOn: true },
  { name: "IMPACT_LLM_CLAUSE_RECONCILE", read: impactLlmClauseReconcileEnabled, defaultsOn: true },
  { name: "IMPACT_LLM_SUMMARY", read: impactLlmSummaryEnabled, defaultsOn: true },
  { name: "IMPACT_LLM_TABLE_JUDGE", read: impactLlmTableJudgeEnabled, defaultsOn: true },
];

/** The levers that stay opt-in, each for a measured reason. */
const DEFAULT_OFF: readonly FlagCase[] = [
  { name: "IMPACT_LLM_ENTITY_SEEDS", read: impactLlmEntitySeedsEnabled, defaultsOn: false },
  { name: "IMPACT_LLM_SEEDING", read: impactLlmSeedingEnabled, defaultsOn: false },
];

const ALL: readonly FlagCase[] = [...DEFAULT_ON, ...DEFAULT_OFF];

describe("#1025 impact flag default matrix", () => {
  it.each(DEFAULT_ON)("$name defaults ON with an empty environment", ({ read }) => {
    expect(read({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each(DEFAULT_OFF)("$name defaults OFF with an empty environment", ({ read }) => {
    expect(read({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("`IMPACT_QUERY_DENOISE` remains on, and remains NOT an LLM stage", () => {
    // Deterministic stopword strip, not a provider call. It defaulted ON long
    // before #1025 and is the idiom the four flips copied.
    expect(requirementQueryDenoiseEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(requirementQueryDenoiseEnabled({ IMPACT_QUERY_DENOISE: "0" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });
});

describe("#1025 every impact flag is still a kill-switch", () => {
  it.each(ALL)("$name is disabled by '0'", ({ name, read }) => {
    expect(read({ [name]: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(ALL)("$name is disabled by 'false'", ({ name, read }) => {
    expect(read({ [name]: "false" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(ALL)("$name is enabled by '1' and 'true'", ({ name, read }) => {
    expect(read({ [name]: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(read({ [name]: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("each kill-switch is INDEPENDENT — disabling one leaves the others on", () => {
    for (const target of DEFAULT_ON) {
      const env = { [target.name]: "0" } as NodeJS.ProcessEnv;
      expect(target.read(env)).toBe(false);
      for (const other of DEFAULT_ON.filter((f) => f.name !== target.name)) {
        expect(other.read(env)).toBe(true);
      }
    }
  });

  it("all four can be switched off together, restoring the deterministic floor", () => {
    const off = Object.fromEntries(
      DEFAULT_ON.map((f) => [f.name, "0"]),
    ) as unknown as NodeJS.ProcessEnv;
    for (const flag of DEFAULT_ON) expect(flag.read(off)).toBe(false);
    for (const flag of DEFAULT_OFF) expect(flag.read(off)).toBe(false);
  });
});
