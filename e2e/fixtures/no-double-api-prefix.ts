/**
 * Shared regression guard for the `/api/api/` double-prefix bug.
 *
 * Background: `ui/src/lib/sdk-alignment-api.ts` previously hard-coded a leading
 * `/api/` on every path while `apiFetch` (ui/src/lib/api-client.ts) already
 * prepends `API_BASE` (`/api`). The result was every SDK-alignment call hitting
 * `/api/api/...`, which the Next.js auth proxy 404'd — and several pages masked
 * that 404 as a silent empty state. The fix removed the redundant prefix.
 *
 * This helper attaches request + response listeners to a Playwright `Page` and
 * records any URL whose path contains the literal `/api/api/` segment. Specs
 * call {@link assertNoDoubleApiPrefix} after the page has settled to fail loudly
 * if the regression ever returns — both on the outbound request side and on the
 * (404) response side, so a masked empty state can never hide it again.
 *
 * Locator/assertion policy: this is a NETWORK-level guard, deliberately
 * independent of any DOM locator so it stays valid even if a page swallows the
 * error into an empty state.
 */
import { expect, type Page } from "@playwright/test";

const DOUBLE_PREFIX = "/api/api/";

export interface DoubleApiPrefixGuard {
  /** Every offending URL captured so far (requests and responses). */
  readonly offenders: string[];
  /**
   * Assert that no `/api/api/` URL was ever observed. Call after the page has
   * settled (e.g. after the list/empty state has rendered).
   */
  assertClean(): void;
  /** Detach the listeners. Optional — Playwright tears the page down per test. */
  dispose(): void;
}

/**
 * Begin watching `page` for `/api/api/` requests and responses. Returns a guard
 * whose `assertClean()` fails the test if the double prefix ever appeared.
 */
export function watchForDoubleApiPrefix(page: Page): DoubleApiPrefixGuard {
  const offenders: string[] = [];

  const onRequest = (req: { url(): string; method(): string }): void => {
    const url = req.url();
    if (url.includes(DOUBLE_PREFIX)) {
      offenders.push(`request ${req.method()} ${url}`);
    }
  };
  const onResponse = (res: { url(): string; status(): number }): void => {
    const url = res.url();
    if (url.includes(DOUBLE_PREFIX)) {
      offenders.push(`response ${res.status()} ${url}`);
    }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    offenders,
    assertClean(): void {
      expect(
        offenders,
        `No request/response URL may contain "${DOUBLE_PREFIX}" (double-prefix regression). ` +
          `Offenders:\n${offenders.join("\n") || "(none)"}`,
      ).toEqual([]);
    },
    dispose(): void {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

/**
 * Convenience one-shot: assert the page never issued a `/api/api/` request.
 * Equivalent to `watchForDoubleApiPrefix(page).assertClean()` but intended for
 * a guard that was started earlier in the test.
 */
export function assertNoDoubleApiPrefix(guard: DoubleApiPrefixGuard): void {
  guard.assertClean();
}
