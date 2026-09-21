/**
 * Per-run TCP port allocation for the Playwright e2e stack (Issue #1067).
 *
 * Problem: `e2e/playwright.config.ts` defaults to the fixed pair 4101 (API) /
 * 3101 (UI). The self-hosted runner executes several jobs CONCURRENTLY, and
 * ports are machine-global even though each runner has its own `_work`
 * directory — so a sibling run holding 4101 makes `generative-e2e` die with
 *
 *     Error: http://127.0.0.1:4101/healthz is already used, make sure that
 *     nothing is running on the port/url or set reuseExistingServer:true
 *
 * `reuseExistingServer: true` is the WRONG fix: it would run this PR's specs
 * against a stale server booted from another branch — turning a loud infra
 * failure into a quiet correctness one. Instead we hand each CI run its own
 * port pair.
 *
 * Two layers, because either alone is insufficient:
 *
 *   1. **Derivation** — the starting slot is `(runId + runAttempt) % slotCount`.
 *      Concurrent runs have different `GITHUB_RUN_ID`s, so they almost always
 *      start from different slots. Deterministic, so the port is reproducible
 *      from the job log when debugging. A re-run bumps `GITHUB_RUN_ATTEMPT`, so
 *      a retry does not inherit a port some zombie process is still holding.
 *   2. **Probing** — two run IDs can still be congruent mod `slotCount`, and a
 *      leaked server from an earlier run can squat a slot. So we walk forward
 *      from the derived slot until both ports of a pair bind cleanly.
 *
 * Probe-then-bind is not atomic; layer 1 is what keeps two simultaneous
 * allocations from converging on the same "free" slot, and layer 2 cleans up
 * the residue. Neither is a lock, and this is deliberately not one — a lock
 * would serialize the job, which is exactly the wall-clock cost this avoids.
 *
 * Port ranges sit below the Linux ephemeral floor (32768) so the kernel never
 * hands one of these out to an unrelated socket, and above 1024 so no
 * privileges are needed.
 */

/** First port of the API range. API port = API_PORT_BASE + slot. */
export const API_PORT_BASE = 21000;
/** First port of the UI range. UI port = UI_PORT_BASE + slot. */
export const UI_PORT_BASE = 22000;
/** Number of distinct slots (21000-21099 / 22000-22099). */
export const SLOT_COUNT = 100;

/**
 * Deterministic starting slot for a run.
 *
 * @param {object} input
 * @param {string|number|undefined} input.runId      - `GITHUB_RUN_ID`.
 * @param {string|number|undefined} [input.runAttempt] - `GITHUB_RUN_ATTEMPT`.
 * @param {number} [input.slotCount=SLOT_COUNT]
 * @returns {number} slot in `[0, slotCount)`.
 */
export function portSlot({ runId, runAttempt, slotCount = SLOT_COUNT }) {
  const id = Number.parseInt(String(runId ?? ""), 10);
  const attempt = Number.parseInt(String(runAttempt ?? ""), 10);
  const safeId = Number.isFinite(id) && id >= 0 ? id : 0;
  const safeAttempt = Number.isFinite(attempt) && attempt >= 0 ? attempt : 0;
  // Outside Actions (`runId` unset) this yields slot 0, which is still probed
  // for freeness below — so a local run degrades to "first free pair", never
  // to a hard-coded collision.
  return (safeId + safeAttempt) % slotCount;
}

/**
 * @typedef {object} PortAllocation
 * @property {number} slot     - slot finally chosen.
 * @property {number} apiPort
 * @property {number} uiPort
 * @property {number} startSlot - slot derived from the run id, before probing.
 * @property {number[]} skipped - slots rejected because a port was in use.
 */

/**
 * Allocate a free `{apiPort, uiPort}` pair for one e2e run.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env=process.env]
 * @param {(port: number) => Promise<boolean>} [options.isFree]
 *        - port predicate; injected in tests. Defaults to a real TCP bind via
 *          `scripts/lib/bootstrap-ports.mjs`.
 * @param {number} [options.slotCount=SLOT_COUNT]
 * @param {number} [options.apiBase=API_PORT_BASE]
 * @param {number} [options.uiBase=UI_PORT_BASE]
 * @param {number} [options.maxAttempts=25]
 * @returns {Promise<PortAllocation>}
 * @throws {Error} when no free pair is found within `maxAttempts` slots.
 */
export async function allocateE2ePorts(options = {}) {
  const {
    env = process.env,
    isFree,
    slotCount = SLOT_COUNT,
    apiBase = API_PORT_BASE,
    uiBase = UI_PORT_BASE,
    maxAttempts = 25,
  } = options;

  const probe = isFree ?? defaultIsFree;
  const startSlot = portSlot({
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    slotCount,
  });

  /** @type {number[]} */
  const skipped = [];
  const attempts = Math.min(maxAttempts, slotCount);

  for (let i = 0; i < attempts; i += 1) {
    const slot = (startSlot + i) % slotCount;
    const apiPort = apiBase + slot;
    const uiPort = uiBase + slot;
    if ((await probe(apiPort)) && (await probe(uiPort))) {
      return { slot, apiPort, uiPort, startSlot, skipped };
    }
    skipped.push(slot);
  }

  throw new Error(
    `No free e2e port pair found after ${attempts} slots starting at ${startSlot} ` +
      `(API ${apiBase}-${apiBase + slotCount - 1}, UI ${uiBase}-${uiBase + slotCount - 1}). ` +
      `Something is squatting the whole range — check for leaked e2e servers on the runner.`,
  );
}

/* c8 ignore start — real TCP bind; unit tests inject `isFree`. */
/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function defaultIsFree(port) {
  const { probePort } = await import("./bootstrap-ports.mjs");
  const result = await probePort(port);
  return result.free;
}
/* c8 ignore stop */

/**
 * Render an allocation as `KEY=value` lines for `$GITHUB_ENV`.
 *
 * These are exactly the two variables `e2e/playwright.config.ts` and
 * `e2e/fixtures/api-base.ts` already honour, so no test code changes.
 *
 * @param {PortAllocation} allocation
 * @returns {string} newline-terminated block.
 */
export function formatGithubEnv(allocation) {
  return `E2E_API_PORT=${allocation.apiPort}\nE2E_UI_PORT=${allocation.uiPort}\n`;
}
