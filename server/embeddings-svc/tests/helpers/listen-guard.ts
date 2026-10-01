/**
 * Issues #689 / #692 — fail any test that opens a TCP listener.
 *
 * The app tests drive Express in process through `invoke()` (./invoke-app.ts). A test
 * that slips back to `supertest` calls `app.listen(0)`, a WILDCARD bind that another
 * process on macOS can shadow with a more specific `127.0.0.1:<port>` bind (#689). This
 * guard turns that into a named failure on the offending test.
 *
 * Usage — `arm()` in `beforeEach`, `check()` as the LAST statement of `afterEach`:
 *
 * ```ts
 * const listenGuard = createListenGuard("#692");
 * beforeEach(() => listenGuard.arm());
 * afterEach(() => { restoreEnv(); listenGuard.check(); });
 * ```
 *
 * `check()` captures the call count, restores `listen`, and only THEN asserts. Asserting
 * first would leave the spy installed when the assertion throws, so every later test in
 * the file would inherit its call count and fail too. It goes last so that a throw cannot
 * skip the caller's own cleanup.
 */
import { Server } from "node:net";
import { expect, vi, type MockInstance } from "vitest";

export interface ListenGuard {
  /** Start counting `net.Server.prototype.listen` calls. Call in `beforeEach`. */
  arm(): void;
  /** Capture, restore, then assert zero calls. Call LAST in `afterEach`. */
  check(): void;
}

export function createListenGuard(issue: string): ListenGuard {
  let spy: MockInstance<Server["listen"]> | undefined;
  return {
    arm() {
      spy = vi.spyOn(Server.prototype, "listen");
    },
    check() {
      const listenCalls = spy?.mock.calls.length ?? 0;
      spy?.mockRestore();
      spy = undefined;
      expect(listenCalls, `a test bound a TCP port — use invoke(), not supertest (${issue})`).toBe(
        0,
      );
    },
  };
}
