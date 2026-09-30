/**
 * #558 — `e2eServerAIEnv` is the one statement of the e2e API server's AI
 * settings. `e2e/playwright.config.ts` starts the server with it AND derives
 * `E2E_AI_OFFLINE` from its `AI_OFFLINE`, which is what live-provider specs
 * read to skip themselves under the offline stub. Getting `AI_OFFLINE` wrong
 * either runs those specs against the stub (they can only fail) or silently
 * skips them against a real provider.
 *
 * The `@metis/e2e` package's `test` script is Playwright, and the root
 * `pnpm test` excludes it, so no vitest config collects `e2e/**\/*.test.ts`.
 * This file lives in `server/tests/` — beside the clarify-fixture parity test
 * that also imports `e2e/fixtures/*` — so the CI `server` job runs it.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_E2E_AI_PROVIDER, e2eServerAIEnv } from "../../e2e/fixtures/ai-mode.js";

const DIR = "/fixtures/llm-558";

describe("e2eServerAIEnv (#558)", () => {
  it("defaults to the offline stub, offline, replaying", () => {
    expect(e2eServerAIEnv({}, DIR)).toEqual({
      AI_PROVIDER: DEFAULT_E2E_AI_PROVIDER,
      AI_OFFLINE: "1",
      AI_REPLAY: "1",
      AI_FIXTURE_DIR: DIR,
    });
    expect(DEFAULT_E2E_AI_PROVIDER).toBe("offline-stub");
  });

  it("treats an explicit offline-stub exactly like the default", () => {
    expect(e2eServerAIEnv({ AI_PROVIDER: "offline-stub" }, DIR).AI_OFFLINE).toBe("1");
  });

  it.each(["openai", "anthropic", "local-gemma", "bedrock-gateway"])(
    "marks an explicit real provider (%s) as NOT offline",
    (provider) => {
      const ai = e2eServerAIEnv({ AI_PROVIDER: provider }, DIR);
      expect(ai.AI_PROVIDER).toBe(provider);
      expect(ai.AI_OFFLINE).toBe("0");
    },
  );

  it("replays by default for a real provider too", () => {
    expect(e2eServerAIEnv({ AI_PROVIDER: "openai" }, DIR).AI_REPLAY).toBe("1");
  });

  it.each([
    ["0", {}],
    ["0", { AI_PROVIDER: "openai" }],
    ["true", {}],
  ])("keeps the caller's AI_REPLAY=%s", (replay, extra) => {
    expect(e2eServerAIEnv({ ...extra, AI_REPLAY: replay }, DIR).AI_REPLAY).toBe(replay);
  });

  it("passes the fixture dir through verbatim, ignoring env.AI_FIXTURE_DIR", () => {
    expect(e2eServerAIEnv({}, "/a").AI_FIXTURE_DIR).toBe("/a");
    expect(e2eServerAIEnv({ AI_FIXTURE_DIR: "/ignored" }, "/b").AI_FIXTURE_DIR).toBe("/b");
  });

  it("does not let a caller's AI_OFFLINE override the provider-derived value", () => {
    expect(e2eServerAIEnv({ AI_OFFLINE: "1", AI_PROVIDER: "openai" }, DIR).AI_OFFLINE).toBe("0");
    expect(e2eServerAIEnv({ AI_OFFLINE: "0" }, DIR).AI_OFFLINE).toBe("1");
  });
});
