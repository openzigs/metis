/**
 * #123 — every `AI_*` millisecond setting goes through the ONE strict parser
 * that #116 wrote for `LOCAL_GEMMA_*_TIMEOUT_MS`.
 *
 * `parseInt` read `1_200_000` and `1.2e6` as `1`, and read `+900000` as 900000
 * by accident; a value past 2^31-1 ms became a 1 ms Node timer. Each of the
 * four forms must keep the setting's default and log a warning that names it.
 *
 * `AI_STREAM_*` (read in `routes/ai.ts`) is covered in
 * `ai-stream-ms-settings-strict.test.ts` (#257).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarn, rateLimitOpts } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  rateLimitOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/logger.js")>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== "config.env-ms") return real;
      return { ...real, warn: logWarn };
    },
  };
});

vi.mock("express-rate-limit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("express-rate-limit")>();
  return {
    ...orig,
    default: (opts: Record<string, unknown>) => {
      rateLimitOpts.push(opts);
      return orig.default(opts as Parameters<typeof orig.default>[0]);
    },
  };
});

import { MAX_NODE_TIMER_MS, MAX_TIMEOUT_MS, parseStrictMs } from "../src/lib/config/env-ms.js";
import { loadAIConfig } from "../src/lib/ai/config.js";
import { OpenAICompatibleProvider } from "../src/lib/ai/providers/openai-compatible-provider.js";
import { approvalTimeoutMs } from "../src/lib/ai/tool-runtime/session-tools.js";
import { getKeyDef } from "../src/lib/config/key-registry.js";

/** The four forms from the issue. Each must keep the default. */
const BAD = ["1_200_000", "1.2e6", "3000000000", "+900000"] as const;

const KEYS = [
  "AI_RATE_LIMIT_WINDOW_MS",
  "AI_PING_TIMEOUT_MS",
  "AI_RETRY_BASE_DELAY_MS",
  "AI_CONVERSATION_RATE_LIMIT_WINDOW_MS",
  "AI_TOOL_APPROVAL_TIMEOUT_MS",
  "AI_OFFLINE",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AI_OFFLINE = "1";
  logWarn.mockReset();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function expectWarned(name: string, raw: string): void {
  expect(logWarn).toHaveBeenCalledWith(
    expect.stringContaining("Ignoring invalid"),
    expect.objectContaining({ env: name, value: raw }),
  );
}

describe("parseStrictMs — the shared parser", () => {
  it("caps at 2^31-1 minus the 30 s headroom", () => {
    expect(MAX_TIMEOUT_MS).toBe(2_147_453_647);
    expect(MAX_TIMEOUT_MS + 30_000).toBe(MAX_NODE_TIMER_MS);
    expect(parseStrictMs("X_MS", String(MAX_TIMEOUT_MS), 5)).toBe(MAX_TIMEOUT_MS);
    expect(parseStrictMs("X_MS", String(MAX_TIMEOUT_MS + 1), 5)).toBe(5);
  });

  it("accepts plain digits, trimmed, inside [min, max]", () => {
    expect(parseStrictMs("X_MS", " 900000 ", 5)).toBe(900_000);
    expect(parseStrictMs("X_MS", "0", 5)).toBe(0);
    expect(parseStrictMs("X_MS", "99", 5, { min: 100 })).toBe(5);
    expect(parseStrictMs("X_MS", "100", 5, { min: 100 })).toBe(100);
    expect(parseStrictMs("X_MS", "101", 5, { max: 100 })).toBe(5);
  });

  it("an explicit max above the cap is clamped to the cap", () => {
    expect(parseStrictMs("X_MS", "3000000000", 5, { max: 4_000_000_000 })).toBe(5);
  });

  it("unset and blank keep the default without a warning", () => {
    expect(parseStrictMs("X_MS", undefined, 5)).toBe(5);
    expect(parseStrictMs("X_MS", null, 5)).toBe(5);
    expect(parseStrictMs("X_MS", "   ", 5)).toBe(5);
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe.each(BAD)("an AI_* millisecond setting written %s keeps its default and warns", (raw) => {
  it("AI_RATE_LIMIT_WINDOW_MS", () => {
    process.env.AI_RATE_LIMIT_WINDOW_MS = raw;
    expect(loadAIConfig().rateLimit.windowMs).toBe(15 * 60_000);
    expectWarned("AI_RATE_LIMIT_WINDOW_MS", raw);
  });

  it("AI_PING_TIMEOUT_MS", () => {
    process.env.AI_PING_TIMEOUT_MS = raw;
    expect(loadAIConfig().pingTimeoutMs).toBe(1_500);
    expectWarned("AI_PING_TIMEOUT_MS", raw);
  });

  it("AI_RETRY_BASE_DELAY_MS", () => {
    process.env.AI_RETRY_BASE_DELAY_MS = raw;
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://gateway.example/v1",
      apiKey: "k",
      model: "m",
      providerKey: "bedrock-gateway",
    }) as unknown as { retryBaseDelayMs: number };
    expect(p.retryBaseDelayMs).toBe(500);
    expectWarned("AI_RETRY_BASE_DELAY_MS", raw);
  });

  it("AI_CONVERSATION_RATE_LIMIT_WINDOW_MS", async () => {
    process.env.AI_CONVERSATION_RATE_LIMIT_WINDOW_MS = raw;
    vi.resetModules();
    rateLimitOpts.length = 0;
    await import("../src/middleware/conversation-rate-limit.js");
    expect(rateLimitOpts.at(-1)?.windowMs).toBe(15 * 60_000);
    // The module was re-imported, so its logger is a fresh mock-wrapped one.
    expectWarned("AI_CONVERSATION_RATE_LIMIT_WINDOW_MS", raw);
  });

  it("AI_TOOL_APPROVAL_TIMEOUT_MS (runtime read)", () => {
    process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = raw;
    expect(approvalTimeoutMs()).toBe(120_000);
    expectWarned("AI_TOOL_APPROVAL_TIMEOUT_MS", raw);
  });

  it("AI_TOOL_APPROVAL_TIMEOUT_MS (admin write is refused by the registry schema)", () => {
    expect(getKeyDef("AI_TOOL_APPROVAL_TIMEOUT_MS")?.schema.safeParse(raw).success).toBe(false);
  });
});

describe("valid AI_* millisecond values are still honoured", () => {
  it("each setting reads a plain-digit value", async () => {
    process.env.AI_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.AI_PING_TIMEOUT_MS = "2500";
    process.env.AI_RETRY_BASE_DELAY_MS = "0";
    process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = "90000";
    process.env.AI_CONVERSATION_RATE_LIMIT_WINDOW_MS = "60000";
    const cfg = loadAIConfig();
    expect(cfg.rateLimit.windowMs).toBe(60_000);
    expect(cfg.pingTimeoutMs).toBe(2_500);
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://gateway.example/v1",
      apiKey: "k",
      model: "m",
      providerKey: "bedrock-gateway",
    }) as unknown as { retryBaseDelayMs: number };
    expect(p.retryBaseDelayMs).toBe(0);
    expect(approvalTimeoutMs()).toBe(90_000);
    vi.resetModules();
    rateLimitOpts.length = 0;
    await import("../src/middleware/conversation-rate-limit.js");
    expect(rateLimitOpts.at(-1)?.windowMs).toBe(60_000);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("the registry schema accepts digits and a JSON number, and rejects 0", () => {
    const schema = getKeyDef("AI_TOOL_APPROVAL_TIMEOUT_MS")!.schema;
    expect(schema.safeParse("120000")).toMatchObject({ success: true, data: 120_000 });
    expect(schema.safeParse(120_000)).toMatchObject({ success: true, data: 120_000 });
    expect(schema.safeParse("0").success).toBe(false);
    expect(schema.safeParse(String(MAX_TIMEOUT_MS)).success).toBe(true);
  });
});

// Review of PR #259 — the lower bounds are part of the runtime read, not only of
// the admin-write schema. `0` would make an approval expire at once (every tool
// call denied) or give express-rate-limit a zero-length window, so the RUNTIME
// read must keep the default. Dropping a `min` from a call site turns these red.
describe("the runtime read enforces each setting's lower bound", () => {
  it("AI_TOOL_APPROVAL_TIMEOUT_MS=0 keeps the default", () => {
    process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = "0";
    expect(approvalTimeoutMs()).toBe(120_000);
    expectWarned("AI_TOOL_APPROVAL_TIMEOUT_MS", "0");
  });

  it("AI_CONVERSATION_RATE_LIMIT_WINDOW_MS=0 keeps the default", async () => {
    process.env.AI_CONVERSATION_RATE_LIMIT_WINDOW_MS = "0";
    vi.resetModules();
    rateLimitOpts.length = 0;
    await import("../src/middleware/conversation-rate-limit.js");
    expect(rateLimitOpts.at(-1)?.windowMs).toBe(15 * 60_000);
    expectWarned("AI_CONVERSATION_RATE_LIMIT_WINDOW_MS", "0");
  });

  it("AI_RATE_LIMIT_WINDOW_MS below 1000 and AI_PING_TIMEOUT_MS below 100 keep their defaults", () => {
    process.env.AI_RATE_LIMIT_WINDOW_MS = "999";
    process.env.AI_PING_TIMEOUT_MS = "99";
    const cfg = loadAIConfig();
    expect(cfg.rateLimit.windowMs).toBe(15 * 60_000);
    expect(cfg.pingTimeoutMs).toBe(1_500);
    expectWarned("AI_RATE_LIMIT_WINDOW_MS", "999");
    expectWarned("AI_PING_TIMEOUT_MS", "99");
  });

  it("each bound is inclusive: the smallest legal value is honoured", async () => {
    process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = "1";
    process.env.AI_RATE_LIMIT_WINDOW_MS = "1000";
    process.env.AI_PING_TIMEOUT_MS = "100";
    process.env.AI_CONVERSATION_RATE_LIMIT_WINDOW_MS = "1";
    expect(approvalTimeoutMs()).toBe(1);
    const cfg = loadAIConfig();
    expect(cfg.rateLimit.windowMs).toBe(1_000);
    expect(cfg.pingTimeoutMs).toBe(100);
    vi.resetModules();
    rateLimitOpts.length = 0;
    await import("../src/middleware/conversation-rate-limit.js");
    expect(rateLimitOpts.at(-1)?.windowMs).toBe(1);
  });
});
