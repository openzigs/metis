/**
 * The agentic code loop's configured token budget. Its own module (#1131) so
 * the analysis snapshot can quote a continuation's budget without importing
 * the agentic pass's prompt and seed machinery.
 */
import { getConfigService } from "../config/config-service.js";

/** Default token budget per agentic agent loop (100k tokens). */
export const DEFAULT_AGENT_TOKEN_BUDGET = 100_000;

/** The configured per-loop token budget (`ANALYSIS_AGENT_TOKEN_BUDGET`). */
export function resolveAgentTokenBudget(): number {
  return getConfigService().getNumber("ANALYSIS_AGENT_TOKEN_BUDGET", DEFAULT_AGENT_TOKEN_BUDGET);
}
