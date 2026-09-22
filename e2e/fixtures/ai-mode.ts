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
