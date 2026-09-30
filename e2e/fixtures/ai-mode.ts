/**
 * Which AI provider the e2e stack is running with.
 *
 * The deterministic harness boots the `offline-stub` provider
 * (`server/src/lib/ai/providers/offline-stub-provider.ts`), whose reply is a
 * content hash rendered as prose. Anything that requires the model to emit
 * STRUCTURED JSON — analysis specialist agents, test-case suggestion
 * generation — therefore cannot produce output under it, and a spec that
 * asserts such output can only fail.
 *
 * `playwright.config.ts` sets `E2E_AI_OFFLINE` from the provider it resolved,
 * so a spec can skip itself with an explicit reason and run for real when the
 * suite is pointed at a live provider (`AI_PROVIDER=... pnpm --filter
 * @metis/e2e test`).
 */
export function isOfflineAiStub(): boolean {
  return (process.env.E2E_AI_OFFLINE ?? "1") === "1";
}

/** Reason string used in `test.skip(...)` so the report says WHY. */
export const OFFLINE_AI_SKIP_REASON =
  "requires a live AI provider: the offline-stub returns hash-derived prose, " +
  "so no structured suggestions/agent JSON can be produced (set AI_PROVIDER to run)";

/** The e2e stack's provider when `AI_PROVIDER` is unset: deterministic, no I/O. */
export const DEFAULT_E2E_AI_PROVIDER = "offline-stub";

/** The AI settings the e2e API server is started with. */
export interface E2EServerAIEnv {
  AI_PROVIDER: string;
  AI_OFFLINE: "0" | "1";
  AI_REPLAY: string;
  AI_FIXTURE_DIR: string;
}

/**
 * #558 — the AI part of the e2e API server's environment, derived from the
 * caller's `env`. `playwright.config.ts` starts the server with it, and the
 * clarify fixture builder (`server/scripts/e2e-build-clarify-fixtures.ts`)
 * builds its provider from it, so both key the replay fixtures on the same
 * provider's model. Restating any of it in either place is how they drift.
 *
 *   - `AI_PROVIDER` — the caller's, else the offline stub.
 *   - `AI_REPLAY`   — replay committed fixtures unless the caller turned it off.
 */
export function e2eServerAIEnv(
  env: Record<string, string | undefined>,
  fixtureDir: string,
): E2EServerAIEnv {
  const provider = env.AI_PROVIDER ?? DEFAULT_E2E_AI_PROVIDER;
  return {
    AI_PROVIDER: provider,
    AI_OFFLINE: provider === DEFAULT_E2E_AI_PROVIDER ? "1" : "0",
    AI_REPLAY: env.AI_REPLAY ?? "1",
    AI_FIXTURE_DIR: fixtureDir,
  };
}
