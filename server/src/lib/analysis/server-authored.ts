/**
 * Epic #1316 (#1318) — provenance for the SERVER-OWNED fields that ride an
 * agent finding.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `agentFindingPayloadSchema` accepts `faithfulness` (like `supportPanel` and
 * `verificationStatus`) so the orchestrator can carry the value it computes on
 * the same object it already persists. Zod therefore also accepts the field
 * from the MODEL. The strict-JSON schema in `structured-output-schemas.ts`
 * makes it unemittable, but that schema is used only where the provider
 * supports structured output — `agent-runner.ts` gates it on
 * `supportsResponseFormat(provider)` and a rejecting provider retries without
 * it — so the plain-Zod path is live, as is `agentic-degradation.ts`'s
 * per-finding salvage.
 *
 * Stripping inside the grader is not enough. `applyFindingFaithfulness` runs on
 * only two of the eight `persistAgentResult(` call sites in `orchestrator.ts`:
 * `runOneAgent` hands `runAgent`'s output straight to persistence for the
 * `document`, `business` and `database` specialists, with no grader in between.
 * On those paths a fabricated `{"score": 1, "totalClaims": 40,
 * "supportedClaims": 40}` would be persisted as a measurement nothing measured,
 * and the flag-off "byte-identical to a pre-#1318 run" promise would be false.
 *
 * ── HOW ────────────────────────────────────────────────────────────────────
 *
 * The server MARKS every value it authors, and the storage boundary — the one
 * choke point all eight call sites share — persists only marked values. The
 * mark is membership of a module-private `WeakSet`, so:
 *
 *   - it cannot be forged by any model output, because a value that arrived as
 *     JSON is a fresh object this module never saw;
 *   - it cannot be serialized, so it never reaches the database, the API or a
 *     log line;
 *   - it holds no strong reference, so marking cannot leak memory.
 *
 * Marking happens where the value is CONSTRUCTED (`toFindingFaithfulness`),
 * not where it is attached, so a future path that computes the metric a
 * different way cannot forget to opt in. The value travels by reference from
 * the grader to `persistAgentResult` — every step in between spreads the
 * finding or concatenates the findings array, and nothing clones it — so the
 * mark survives. A path that DID clone (a JSON round trip, `structuredClone`)
 * would drop a genuine metric rather than admit a fabricated one, which is the
 * safe direction for a number an operator reads as a measurement.
 */

const authored = new WeakSet<object>();

/**
 * Record `value` as authored by the SERVER and return it unchanged.
 *
 * Identity-based: the returned reference is the one that must reach the storage
 * boundary. Copying the object (spread, `structuredClone`, a JSON round trip)
 * produces an unmarked value that will be treated as model-authored.
 */
export function markServerAuthored<T extends object>(value: T): T {
  authored.add(value);
  return value;
}

/** Was this exact object constructed by the server? */
export function isServerAuthored(value: unknown): boolean {
  return typeof value === "object" && value !== null && authored.has(value as object);
}
