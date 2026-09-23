/**
 * #60 — the rate limiters resolve their backing store on FIRST USE, not at import.
 *
 * `DISCUSSION_RATE_LIMIT_BACKEND=postgres` is production's setting
 * (deploy/helm/metis/values-prod.yaml). Its store factory is registered by
 * `createServer()`, which runs after every module has been imported, and an
 * unregistered factory throws. Three limiters resolved the store at module scope, so
 * under production's values the server exited at import — found by the image smoke's
 * Postgres arm, which now runs production's backends. Each case imports its module
 * with the backend selected and NO factory registered (the import must not throw),
 * registers a factory afterwards, and asserts the first check uses it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RateLimitStore } from "../src/lib/discussions/rate-limit-store.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const window = { max: 5, windowMs: 60_000 };

/** Each case imports its module and returns the check to run later. */
describe.each([
  {
    name: "discussions/ai-rate-limit",
    load: async () => {
      const m = await import("../src/lib/discussions/ai-rate-limit.js");
      return () => m.checkThreadAIRateLimit({ threadId: "t", userId: "u" }, window);
    },
  },
  {
    name: "discussions/notify",
    load: async () => {
      const m = await import("../src/lib/discussions/notify.js");
      return () => m.allowMentionNotification("t", "u", window);
    },
  },
  {
    name: "teams/inbound-rate-limit",
    load: async () => {
      const m = await import("../src/lib/teams/inbound-rate-limit.js");
      return () => m.checkInboundRateLimit({ workspaceId: "w", conversationId: "c" }, window);
    },
  },
])("$name", ({ load }) => {
  it("imports under DISCUSSION_RATE_LIMIT_BACKEND=postgres before the factory is registered", async () => {
    vi.resetModules();
    vi.stubEnv("DISCUSSION_RATE_LIMIT_BACKEND", "postgres");
    const seam = await import("../src/lib/discussions/rate-limit-store.js");
    const check = await load();

    const hit = vi.fn(async () => ({ allowed: true, recentCount: 1 }));
    const store: RateLimitStore = { hit, reset: async () => {} };
    seam.__setPostgresStoreFactory(() => store);

    await check();
    expect(hit).toHaveBeenCalledTimes(1);
  });
});
