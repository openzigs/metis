/**
 * #1512 — fail any default-suite (`server-unit`) test that opens an outbound network
 * connection or spawns `git` against a remote. Mechanism and rationale:
 * `helpers/egress-guard.ts`. Loopback (supertest, a local mock server) is always allowed.
 *
 * Scope: loaded only by `vitest.config.ts`, never by `vitest.integration.config.ts`.
 * It also stands down when `RUN_INTEGRATION_TESTS` is set, which is how the
 * `postgres-unit` / `postgres-adapter` CI jobs run this same config against a real
 * database: those suites legitimately connect to local services, and a guard there
 * would only couple them to how their service's address happens to be spelled.
 */
import { afterAll, afterEach, expect } from "vitest";
import { ACTIVE_EGRESS_GUARD, installEgressGuard } from "./helpers/egress-guard.js";

/**
 * Suites allowed to reach the network, keyed by path relative to `server/`, each with
 * the reason. Keep it empty unless a test genuinely needs a remote; loopback needs no
 * entry.
 */
export const EGRESS_ALLOWLIST: Readonly<Record<string, string>> = {};

function currentSuiteAllowance(): string | null {
  const testPath = expect.getState().testPath;
  if (!testPath) return null;
  const rel = testPath.replace(/\\/g, "/").replace(/^.*?\/server\//, "");
  return EGRESS_ALLOWLIST[rel] ?? null;
}

if (!process.env.RUN_INTEGRATION_TESTS) {
  const guard = installEgressGuard({
    isAllowed: currentSuiteAllowance,
    // A fire-and-forget refusal is reported by whichever test drains next; the message
    // names the test that was running when it happened, which is usually the culprit.
    context: () => expect.getState().currentTestName ?? undefined,
  });
  (globalThis as Record<symbol, unknown>)[ACTIVE_EGRESS_GUARD] = guard;
  const failOnViolations = () => {
    const violations = guard.drain();
    if (violations.length > 0) {
      throw new Error(
        `Egress guard (#1512): a unit test reached outside this machine. Stub the ` +
          `network/clone path instead.\n  - ${[...new Set(violations)].join("\n  - ")}`,
      );
    }
  };
  afterEach(failOnViolations);
  afterAll(failOnViolations);
  // Anything refused after the last afterAll cannot fail a test; at least say so.
  process.once("exit", () => {
    const late = guard.drain();
    if (late.length > 0) {
      process.stderr.write(
        `Egress guard (#1512): refused after the suite ended:\n  - ${late.join("\n  - ")}\n`,
      );
    }
  });
}
