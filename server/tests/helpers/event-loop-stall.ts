/**
 * Issue #216 — measure how long the calling thread's event loop is held while
 * `work` runs, directly, instead of inferring it from HTTP probes.
 *
 * A timer ticks every `intervalMs`; the longest gap between consecutive turns is
 * the longest stretch during which nothing else on this thread — `/healthz`, any
 * API request — could have run. Measuring the gap rather than counting requests
 * is what makes the #189 tests deterministic: a synchronous block of N ms can
 * only ever LENGTHEN the observed gap, never shorten it, so CPU contention cannot
 * turn "the loop was blocked" into "the loop was free". (The #189 prober counted
 * completed `/healthz` round-trips, and a cold first fetch under load left it with
 * one probe — `expected 1 to be greater than 1`.)
 */
export interface LoopStallReport {
  /** Longest gap between two turns of this thread's event loop, in ms. */
  longestStallMs: number;
  /** Wall time `work` took, in ms. */
  elapsedMs: number;
}

export async function measureLoopStallDuring(
  work: () => Promise<unknown>,
  intervalMs = 5,
): Promise<LoopStallReport> {
  let last = performance.now();
  let longest = 0;
  const sample = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  };
  const ticker = setInterval(sample, intervalMs);
  const started = performance.now();
  try {
    await work();
  } finally {
    clearInterval(ticker);
  }
  const elapsedMs = performance.now() - started;
  // A block that lasts until `work` settles has no tick after it yet: close it here.
  sample();
  return { longestStallMs: longest, elapsedMs };
}
