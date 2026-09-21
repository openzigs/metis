/**
 * Config-gated claim-extraction model override (Epic #696 / Issue #701).
 *
 * The docs-gen claim extractor defaults to Haiku on the paid providers — a
 * deliberate cost choice for a high-volume, mechanical decomposition task (see
 * the crossover analysis in `cache-crossover.ts` and `docs/OPERATIONS.md` §7.5,
 * which concludes Haiku wins at the estimated input:output ratio). This module
 * exposes a SINGLE, admin-visible, validated knob to flip that default without a
 * code change, should a future workload or measured hit rate justify moving
 * claim extraction to cached-Sonnet.
 *
 * Design mirrors `prompt-cache-ttl.ts`: one place reads the `DOCS_GEN_CLAIM_MODEL`
 * registry key so provider tuning stays in lock-step with the config layer. The
 * key is unset by default, so `resolveClaimModelOverride` returns `undefined` and
 * `docsGenTuning` keeps its current per-provider Haiku default — NO behaviour
 * change unless an operator explicitly opts in. Rollback is a config unset / env
 * removal.
 *
 * Precedence in `docsGenTuning` places this cross-provider key BELOW the existing
 * provider-specific overrides (`DOCS_GEN_ANTHROPIC_CLAIM_MODEL`,
 * `DOCS_GEN_BEDROCK_CLAIM_MODEL`, `DOCS_GEN_GROUNDING_MODEL`) so a targeted
 * override always wins, and above only the hardcoded Haiku default.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";

/** Registry key for the cross-provider claim-extraction model override. */
export const DOCS_GEN_CLAIM_MODEL_KEY = "DOCS_GEN_CLAIM_MODEL";

/**
 * Resolve the operator-configured claim-extraction model, or `undefined` when
 * unset (the default — current Haiku behaviour is preserved). Reads through the
 * ConfigService so a runtime tunable change (db → env) takes effect without a
 * restart. `config` is injectable for tests. A blank/whitespace value is treated
 * as unset.
 */
export function resolveClaimModelOverride(
  config: ConfigService = getConfigService(),
): string | undefined {
  const raw = config.get(DOCS_GEN_CLAIM_MODEL_KEY);
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
