/**
 * Logger redaction tests.
 *
 * The crux of #1263 is that **both** directions must be asserted on the same
 * run: credential-shaped keys still redact, and count-shaped keys now survive.
 * A suite that only asserts the counts survive is half a gate — it goes green
 * on a discriminator that deleted `/token/i` outright.
 */
import { Writable } from "node:stream";
import winston from "winston";
import { describe, expect, it } from "vitest";
import {
  SENSITIVE_KEY_PATTERNS,
  logger,
  redact,
  redactInfo,
  tokenCountMetaKeys,
} from "../src/lib/logger.js";
import {
  normalizeAnthropicNativeUsage,
  normalizeOpenAICompatibleUsage,
  normalizeTokenUsage,
} from "../src/lib/ai/cache-verification.js";
import { compactionLogMeta } from "../src/lib/analysis/context-window-manager.js";

describe("logger.redact", () => {
  it("redacts Authorization, Cookie, *_KEY, *_SECRET, *_TOKEN, password", () => {
    const out = redact({
      Authorization: "Bearer x",
      cookie: "session=y",
      VAULT_MASTER_KEY: "k",
      JWT_SECRET: "s",
      access_token: "t",
      password: "p",
      keep: "ok",
    }) as Record<string, string>;
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.VAULT_MASTER_KEY).toBe("[REDACTED]");
    expect(out.JWT_SECRET).toBe("[REDACTED]");
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.keep).toBe("ok");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redact({
      headers: [{ authorization: "x" }, { accept: "*/*" }],
    }) as { headers: Array<Record<string, string>> };
    expect(out.headers[0].authorization).toBe("[REDACTED]");
    expect(out.headers[1].accept).toBe("*/*");
  });

  it("stops descending past the depth cap and passes scalars through", () => {
    // Beyond six levels the walk returns the subtree untouched, so a secret
    // buried deeper than the cap is NOT redacted — a known bound, asserted so
    // it is a decision rather than a surprise.
    let deep: Record<string, unknown> = { authorization: "x" };
    for (let i = 0; i < 8; i++) deep = { nest: deep };
    expect(JSON.stringify(redact(deep))).toContain("authorization");
    expect(redact("plain")).toBe("plain");
    expect(redact(7)).toBe(7);
    expect(redact(null)).toBeNull();
  });
});

/**
 * Stand-in for a credential value. Deliberately NOT shaped like a real
 * provider token. A realistic-looking OAuth access-token literal reads as a
 * live credential to the `p/secrets` Semgrep rule and blocks CI, which is the
 * right behaviour from that gate — a test fixture is not a reason to teach the
 * repo to ignore secret-shaped strings.
 */
const SECRET_LOOKALIKE = "opaque-credential-value-for-tests";

/**
 * Direction 1 of the mutation pair. Every one of these matches `/token/i` and
 * every one of them is a credential — loosening or deleting that pattern makes
 * this block fail.
 */
const CREDENTIAL_TOKEN_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "bearer_token",
  "api_token",
  "accessToken",
  "refreshToken",
  "bearerToken",
  "ACCESS_TOKEN",
  "x-auth-token",
  "tokenId",
  "tokenSecret",
] as const;

/**
 * Direction 2. Every one of these matches `/token/i` too, and every one is a
 * count — before #1263 all of them logged `[REDACTED]`.
 */
const COUNT_TOKEN_KEYS = [
  "promptTokens",
  "completionTokens",
  "thinkingTokens",
  "thinking_tokens",
  "estimatedTokens",
  "savedTokens",
  "watermarkTokens",
  "totalTokens",
  "maxOutputTokens",
  "cacheReadTokens",
  "tokenBudget",
  "tokens",
] as const;

describe("logger.redact — token counts vs token credentials (#1263)", () => {
  it("still redacts credential-shaped token keys", () => {
    for (const key of CREDENTIAL_TOKEN_KEYS) {
      const out = redact({ [key]: SECRET_LOOKALIKE }) as Record<string, unknown>;
      expect(out[key], `${key} must be redacted`).toBe("[REDACTED]");
    }
  });

  it("lets count-shaped token keys through with their numeric value intact", () => {
    for (const key of COUNT_TOKEN_KEYS) {
      const out = redact({ [key]: 9763 }) as Record<string, unknown>;
      expect(out[key], `${key} must survive redaction`).toBe(9763);
    }
  });

  it("redacts an allowlisted count key when its value is not a number", () => {
    // The belt to the allowlist's braces: a mistaken entry cannot leak a
    // string credential, which is why the generic name `tokens` is safe to
    // allow at all.
    expect((redact({ tokens: SECRET_LOOKALIKE }) as Record<string, unknown>).tokens).toBe(
      "[REDACTED]",
    );
    expect(
      (redact({ promptTokens: { nested: "secret" } }) as Record<string, unknown>).promptTokens,
    ).toBe("[REDACTED]");
    expect((redact({ maxTokens: [1, 2] }) as Record<string, unknown>).maxTokens).toBe("[REDACTED]");
    expect((redact({ tokens: Number.NaN }) as Record<string, unknown>).tokens).toBe("[REDACTED]");
    expect((redact({ tokens: Number.POSITIVE_INFINITY }) as Record<string, unknown>).tokens).toBe(
      "[REDACTED]",
    );
  });

  it("passes a nullish count through rather than reporting it as redacted", () => {
    const out = redact({ maxTokens: undefined, savedTokens: null }) as Record<string, unknown>;
    expect(out.maxTokens).toBeUndefined();
    expect(out.savedTokens).toBeNull();
  });

  it("applies the exemption at any nesting depth", () => {
    const out = redact({
      usage: { promptTokens: 39837, access_token: "t" },
      turns: [{ thinkingTokens: 5088 }],
    }) as {
      usage: Record<string, unknown>;
      turns: Array<Record<string, unknown>>;
    };
    expect(out.usage.promptTokens).toBe(39837);
    expect(out.usage.access_token).toBe("[REDACTED]");
    expect(out.turns[0].thinkingTokens).toBe(5088);
  });

  it("treats camel, snake, screaming and hyphenated spellings as one entry", () => {
    for (const key of ["promptTokens", "prompt_tokens", "PROMPT_TOKENS", "prompt-tokens"]) {
      expect((redact({ [key]: 12 }) as Record<string, unknown>)[key], key).toBe(12);
    }
  });

  it("redacts an unclassified token-shaped key — the allowlist fails closed", () => {
    // Neither a known count nor a known credential. A numeric value is not
    // enough on its own; only enumeration exempts.
    for (const key of ["sessionToken", "vaultTokens", "someNewToken", "csrfTokens"]) {
      expect((redact({ [key]: 42 }) as Record<string, unknown>)[key], key).toBe("[REDACTED]");
    }
  });
});

describe("logger — the top-level info pass agrees with the recursive walk", () => {
  it("exempts counts and redacts credentials on the winston info record", () => {
    const info = redactInfo({
      level: "debug",
      message: "Agent loop turn accounting",
      service: "metis-server",
      promptTokens: 39837,
      completionTokens: 512,
      thinking_tokens: 9763,
      access_token: SECRET_LOOKALIKE,
      authorization: "Bearer x",
    });
    expect(info.promptTokens).toBe(39837);
    expect(info.completionTokens).toBe(512);
    expect(info.thinking_tokens).toBe(9763);
    expect(info.access_token).toBe("[REDACTED]");
    expect(info.authorization).toBe("[REDACTED]");
    // Reserved fields are passed over untouched.
    expect(info.message).toBe("Agent loop turn accounting");
  });
});

describe("logger — the wired winston instance, end to end", () => {
  it("emits token counts in the clear and credentials redacted", async () => {
    // Not `redact()` and not `redactInfo()` but the exported `logger` with its
    // real format chain — the path production actually logs through.
    const captured: Array<Record<string, unknown>> = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _enc, cb) {
          captured.push(JSON.parse(String(chunk)) as Record<string, unknown>);
          cb();
        },
      }),
      format: winston.format.json(),
    });
    logger.add(transport);
    try {
      logger.warn("Agent response hit the output cap", {
        promptTokens: 39837,
        thinking_tokens: 9763,
        maxOutputTokens: 21000,
        refresh_token: SECRET_LOOKALIKE,
        agentKey: "winston",
      });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logger.remove(transport);
    }
    const line = captured.find((e) => e.message === "Agent response hit the output cap");
    expect(line, "the logger emitted nothing").toBeDefined();
    expect(line!.promptTokens).toBe(39837);
    expect(line!.thinking_tokens).toBe(9763);
    expect(line!.maxOutputTokens).toBe(21000);
    expect(line!.refresh_token).toBe("[REDACTED]");
    expect(line!.agentKey).toBe("winston");
  });
});

describe("logger — the allowlist is internally consistent", () => {
  const allowlist = [...tokenCountMetaKeys()];

  it("is non-empty and already normalised", () => {
    expect(allowlist.length).toBeGreaterThan(0);
    for (const key of allowlist) expect(key, key).toMatch(/^[a-z0-9]+$/);
  });

  it("exempts nothing that looks sensitive for a reason other than /token/i", () => {
    // A future entry like `secretTokens` or `apiKeyTokens` would exempt a key
    // that a *different* pattern was guarding. Fail the build on it.
    const others = SENSITIVE_KEY_PATTERNS.filter((rx) => rx.source !== "token");
    expect(others.length).toBe(SENSITIVE_KEY_PATTERNS.length - 1);
    for (const key of allowlist) {
      const matched = others.filter((rx) => rx.test(key)).map((rx) => rx.source);
      expect(matched, `${key} is exempted but also matches ${matched.join(", ")}`).toEqual([]);
    }
  });

  it("contains only keys the /token/i guard would otherwise have swallowed", () => {
    // An entry that does not match /token/i is dead weight — it exempts a key
    // that was never redacted, which hides a typo.
    for (const key of allowlist) expect(key, `${key} does not match /token/i`).toMatch(/token/i);
  });
});

/**
 * The #1225 defect, restated: a redaction test assembled from key-name
 * literals passes whether or not production uses those names. These arms take
 * the object production actually builds, enumerate **its** keys, and assert
 * the round trip — so a rename in production is either still covered or breaks
 * the test, never silently uncovered.
 */
describe("logger.redact — round-trips the real logged objects (#1225, #1263)", () => {
  /** Assert every /token/i-named field of a real object survives verbatim. */
  function expectCountsSurvive(real: Record<string, unknown>, label: string) {
    const tokenish = Object.entries(real).filter(([k]) => /token/i.test(k));
    // Guard against a vacuous pass: an object with no token-shaped keys would
    // satisfy the loop below trivially.
    expect(
      tokenish.length,
      `${label} exposes no /token/i keys — the arm is vacuous`,
    ).toBeGreaterThan(0);
    const out = redact(real) as Record<string, unknown>;
    for (const [key, value] of tokenish) {
      expect(out[key], `${label}.${key} was swallowed`).toBe(value);
    }
    // And the object as a whole round-trips, so a non-token sibling is not
    // collateral damage.
    expect(out).toEqual(real);
  }

  it("round-trips normalizeAnthropicNativeUsage's output", () => {
    const real = normalizeAnthropicNativeUsage({
      input_tokens: 1200,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 450,
    }) as unknown as Record<string, unknown>;
    expectCountsSurvive(real, "normalizeAnthropicNativeUsage");
  });

  it("round-trips normalizeOpenAICompatibleUsage's output", () => {
    const real = normalizeOpenAICompatibleUsage({
      prompt_tokens: 5120,
      completion_tokens: 640,
      prompt_tokens_details: { cached_tokens: 4096 },
    }) as unknown as Record<string, unknown>;
    expectCountsSurvive(real, "normalizeOpenAICompatibleUsage");
  });

  it("round-trips normalizeTokenUsage's output", () => {
    const real = normalizeTokenUsage(
      { promptTokens: 39837, completionTokens: 512, totalTokens: 40349, cacheReadTokens: 20000 },
      "openai-compatible",
    ) as unknown as Record<string, unknown>;
    expectCountsSurvive(real, "normalizeTokenUsage");
  });

  it("round-trips the raw provider usage payloads themselves", () => {
    // The shapes the SDKs hand back, as they would appear in a debug dump.
    const anthropicRaw = {
      input_tokens: 1200,
      output_tokens: 830,
      thinking_tokens: 9763,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 450,
    };
    expectCountsSurvive(anthropicRaw, "anthropic raw usage");
    const openaiRaw = { prompt_tokens: 5120, completion_tokens: 640, total_tokens: 5760 };
    expectCountsSurvive(openaiRaw, "openai raw usage");
  });

  it("round-trips compactionLogMeta's output, token-named or not", () => {
    // #1225 renamed these keys to dodge the guard. Whether they stay renamed
    // or are restored, the real meta object must survive redaction intact —
    // and this is derived from the function, not from a copy of its key names.
    const real = compactionLogMeta(
      { compacted: true, messagesCompacted: 12, tokensBefore: 39837, tokensAfter: 12004 },
      32000,
      16000,
    ) as unknown as Record<string, unknown>;
    expect(Object.keys(real).length).toBeGreaterThan(0);
    expect(redact(real)).toEqual(real);
  });
});

/**
 * #68 — an `Error` in log METADATA used to serialise as `{}`.
 *
 * `redact()` rebuilds every object from `Object.entries(...)`, and an Error's
 * `name` / `message` / `stack` are not own *enumerable* properties, so
 * `log.error("…", { err })` recorded no detail at all. `errors({ stack: true })`
 * only covers an Error passed as the log *message* or as the top-level info
 * object, never one nested in metadata — which is the shape nearly every call
 * site in `server/src` uses.
 *
 * Both directions matter on the same run: the message and stack must survive,
 * AND a credential-named own property hung off the error must still redact.
 */
describe("logger.redact — an Error in metadata (#68)", () => {
  it("serialises a top-level `err` with name, message and stack", () => {
    const info = redactInfo({
      level: "error",
      message: "m",
      err: new Error("secret detail"),
      docId: "d",
    });
    const err = info.err as Record<string, unknown>;
    expect(err.name).toBe("Error");
    expect(err.message).toBe("secret detail");
    expect(typeof err.stack).toBe("string");
    expect(String(err.stack)).toContain("secret detail");
    // The structured fields either side of it are untouched.
    expect(info.docId).toBe("d");
    expect(info.message).toBe("m");
  });

  it("serialises the `error` key shape too, not just `err`", () => {
    const info = redactInfo({ level: "warn", message: "m", error: new TypeError("bad type") });
    const err = info.error as Record<string, unknown>;
    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("bad type");
    expect(typeof err.stack).toBe("string");
  });

  it("serialises an Error nested inside metadata and inside an array", () => {
    const out = redact({
      ctx: { cause: new Error("nested boom") },
      attempts: [new Error("first"), { inner: new Error("second") }],
    }) as Record<string, unknown>;
    const cause = (out.ctx as Record<string, unknown>).cause as Record<string, unknown>;
    expect(cause.message).toBe("nested boom");
    expect(typeof cause.stack).toBe("string");
    const attempts = out.attempts as Array<Record<string, unknown>>;
    expect(attempts[0].message).toBe("first");
    expect((attempts[1].inner as Record<string, unknown>).message).toBe("second");
  });

  it("keeps an error's own enumerable properties, redacting the sensitive ones", () => {
    const err = Object.assign(new Error("provider refused"), {
      status: 402,
      token: SECRET_LOOKALIKE,
      apiKey: SECRET_LOOKALIKE,
      requestId: "req-7",
    });
    const out = redact({ err }) as Record<string, Record<string, unknown>>;
    expect(out.err.message).toBe("provider refused");
    expect(out.err.status).toBe(402);
    expect(out.err.requestId).toBe("req-7");
    expect(out.err.token).toBe("[REDACTED]");
    expect(out.err.apiKey).toBe("[REDACTED]");
  });

  it("carries a subclass's own name and nested cause", () => {
    class AIProviderError extends Error {
      constructor(
        message: string,
        readonly status: number,
      ) {
        super(message);
        this.name = "AIProviderError";
      }
    }
    const out = redact({
      err: Object.assign(new AIProviderError("gateway said no", 429), {
        cause: new Error("socket hang up"),
      }),
    }) as Record<string, Record<string, unknown>>;
    expect(out.err.name).toBe("AIProviderError");
    expect(out.err.message).toBe("gateway said no");
    expect(out.err.status).toBe(429);
    expect((out.err.cause as Record<string, unknown>).message).toBe("socket hang up");
  });

  it("still redacts an Error held under a credential-named key", () => {
    const out = redact({ authorization: new Error("Bearer leak") }) as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
  });

  it("writes message and stack through the wired winston instance", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _enc, cb) {
          captured.push(JSON.parse(String(chunk)) as Record<string, unknown>);
          cb();
        },
      }),
      format: winston.format.json(),
    });
    logger.add(transport);
    try {
      logger.error("Doc generation failed", { err: new Error("boom"), docId: "doc-1" });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logger.remove(transport);
    }
    const line = captured.find((e) => e.message === "Doc generation failed");
    expect(line, "the logger emitted nothing").toBeDefined();
    const err = line!.err as Record<string, unknown>;
    expect(err.message).toBe("boom");
    expect(String(err.stack)).toContain("boom");
    expect(line!.docId).toBe("doc-1");
  });
});

/**
 * #85 — `AggregateError.errors` is an own but NON-ENUMERABLE property.
 *
 * #68 enumerated `name` / `message` / `stack` / `cause` explicitly because
 * `Object.entries(err)` returns `[]` for them. `errors` has exactly the same
 * descriptor and was not on that list, so it was dropped by both the explicit
 * keys and the `...err` spread: every `Promise.any` rejection and every
 * batched-connector failure logged an `AggregateError` whose sub-errors — the
 * only part that says WHY each attempt failed — were gone. The surviving
 * `message` is `"All promises were rejected"`, which is why nothing looked
 * broken.
 *
 * Both directions on the same run, as in the #68 block above: the sub-errors
 * must serialise, AND a credential hung off a sub-error must still redact —
 * an `errors` array that bypassed the recursive walk would satisfy the first
 * assertion alone.
 */
describe("logger.redact — AggregateError sub-errors (#85)", () => {
  it("serialises each entry of `errors`, not just the aggregate's own message", () => {
    const out = redact({
      err: new AggregateError(
        [new Error("primary down"), new TypeError("bad shape")],
        "all failed",
      ),
    }) as Record<string, Record<string, unknown>>;
    expect(out.err.name).toBe("AggregateError");
    expect(out.err.message).toBe("all failed");
    const errors = out.err.errors as Array<Record<string, unknown>>;
    expect(errors, "AggregateError.errors did not survive serialisation").toHaveLength(2);
    expect(errors[0].name).toBe("Error");
    expect(errors[0].message).toBe("primary down");
    expect(typeof errors[0].stack).toBe("string");
    expect(errors[1].name).toBe("TypeError");
    expect(errors[1].message).toBe("bad shape");
  });

  it("redacts a credential hung off a sub-error", () => {
    const sub = Object.assign(new Error("gateway refused"), {
      status: 401,
      apiKey: SECRET_LOOKALIKE,
    });
    const out = redact({ err: new AggregateError([sub], "all failed") }) as Record<
      string,
      Record<string, unknown>
    >;
    const errors = out.err.errors as Array<Record<string, unknown>>;
    expect(errors[0].status).toBe(401);
    expect(errors[0].message).toBe("gateway refused");
    expect(errors[0].apiKey).toBe("[REDACTED]");
  });

  it("serialises the sub-errors of a real Promise.any rejection", async () => {
    const rejected = await Promise.any([
      Promise.reject(new Error("connector a: ECONNREFUSED")),
      Promise.reject(new Error("connector b: 503")),
    ]).catch((err: unknown) => err);
    const out = redact({ err: rejected }) as Record<string, Record<string, unknown>>;
    const errors = out.err.errors as Array<Record<string, unknown>>;
    expect(errors.map((e) => e.message)).toEqual(["connector a: ECONNREFUSED", "connector b: 503"]);
  });

  it("carries an aggregate nested inside metadata and through winston", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _enc, cb) {
          captured.push(JSON.parse(String(chunk)) as Record<string, unknown>);
          cb();
        },
      }),
      format: winston.format.json(),
    });
    logger.add(transport);
    try {
      logger.error("Every connector failed", {
        ctx: { err: new AggregateError([new Error("inner reason")], "all failed") },
      });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logger.remove(transport);
    }
    const line = captured.find((e) => e.message === "Every connector failed");
    expect(line, "the logger emitted nothing").toBeDefined();
    const err = (line!.ctx as Record<string, unknown>).err as Record<string, unknown>;
    const errors = err.errors as Array<Record<string, unknown>>;
    expect(errors[0].message).toBe("inner reason");
  });

  it("leaves a non-array `errors` property alone", () => {
    // Only the AggregateError shape is captured. An ordinary error carrying a
    // scalar `errors` must not gain a fabricated array, and an own ENUMERABLE
    // `errors` still wins the spread as any other own property does.
    const scalar = redact({ err: Object.assign(new Error("x"), { errors: 3 }) }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(scalar.err.errors).toBe(3);
    const enumerable = redact({
      err: Object.assign(new Error("x"), { errors: [{ detail: "own enumerable" }] }),
    }) as Record<string, Record<string, unknown>>;
    expect(enumerable.err.errors).toEqual([{ detail: "own enumerable" }]);
    // And an ordinary error gains no empty `errors` key: a default of `[]` here
    // would put a meaningless field on every logged error in the codebase.
    const plain = redact({ err: new Error("x") }) as Record<string, Record<string, unknown>>;
    expect("errors" in plain.err).toBe(false);
  });
});
