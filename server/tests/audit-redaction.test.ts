/**
 * #1268 — the persisted-audit sink's redaction guard, proved in **both**
 * directions.
 *
 * `audit-service.ts` carried its own copy of `SENSITIVE_KEY_PATTERNS` including
 * `/token/i`, so every token count it persisted read `[REDACTED]` — which is
 * why `custom-agents/invocation-audit.ts` renamed its fields to dodge the
 * guard rather than the guard being fixed. It now consults the one shared
 * exemption exported from `logger.ts` (`REDACTION_SINK_POLICY:
 * exempt-token-counts`, `docs/decisions/0008-redaction-sinks.md`).
 *
 * A one-directional test is half a gate. Every case below has a partner that
 * fails in the opposite direction: narrowing the guard too far breaks the
 * "still redacts" arm, and reverting the narrowing breaks the "survives" arm.
 */
import { describe, expect, it } from "vitest";
import { redact, buildAuditLogData } from "../src/lib/audit/audit-service.js";
import { tokenCountMetaKeys, isTokenCountExempt } from "../src/lib/logger.js";

const REDACTED = "[REDACTED]";

/** Shorthand: redact one flat object and return it typed. */
function r(input: Record<string, unknown>): Record<string, unknown> {
  return redact(input) as Record<string, unknown>;
}

describe("audit sink — credential-shaped keys still redact (#1268)", () => {
  /**
   * Direction 1. Each of these is a credential or a handle to one. If the
   * narrowing were mistakenly written as "exclude anything matching /token/i"
   * — the repair #1263 rejected — `accessToken`, `refreshToken`, `authToken`
   * and `tokenId` would all sail through and this block would fail.
   */
  const CREDENTIAL_KEYS = [
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "password",
    "secret",
    "apiKey",
    "api_key",
    "privateKey",
    "credential",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "bearerToken",
    "authToken",
    "sessionToken",
    // `tokenId` at server/src/lib/acp/server.ts is a handle to a *verified*
    // bearer token — classified a credential by #1263 and still one here.
    "tokenId",
  ];

  it.each(CREDENTIAL_KEYS)("redacts %s", (key) => {
    expect(r({ [key]: "s3cr3t-value" })[key]).toBe(REDACTED);
  });

  it("redacts a credential nested inside an allowlisted count key", () => {
    // The value clause is the belt to the allowlist's braces: `tokens` is an
    // allowlisted *name*, so a string value must not ride through on the name.
    expect(r({ tokens: "sk-ant-api03-notacount" }).tokens).toBe(REDACTED);
    expect(r({ totalTokens: "Bearer abc" }).totalTokens).toBe(REDACTED);
    expect(r({ promptTokens: { nested: "x" } }).promptTokens).toBe(REDACTED);
    expect(r({ maxTokens: true }).maxTokens).toBe(REDACTED);
  });

  it("redacts credential keys nested inside objects and arrays", () => {
    const out = r({
      outer: { inner: { accessToken: "abc", promptTokens: 12 } },
      list: [{ apiKey: "k1", totalTokens: 7 }],
    });
    const outer = (out.outer as Record<string, Record<string, unknown>>).inner;
    expect(outer.accessToken).toBe(REDACTED);
    expect(outer.promptTokens).toBe(12);
    const first = (out.list as Record<string, unknown>[])[0];
    expect(first.apiKey).toBe(REDACTED);
    expect(first.totalTokens).toBe(7);
  });

  it("redacts a key that is not an enumerated count even when its value is numeric", () => {
    // Fail-closed: a *new* credential-shaped key is redacted by default. Adding
    // it to the allowlist is a deliberate act, not an accident of shape.
    expect(r({ someNewToken: 4096 }).someNewToken).toBe(REDACTED);
    expect(r({ tokenVersion: 3 }).tokenVersion).toBe(REDACTED);
  });
});

describe("audit sink — enumerated token counts survive (#1268)", () => {
  /**
   * Direction 2, derived from the sink's **own** call sites rather than a
   * hand-typed list. These are the `/token/i` metadata keys that real
   * `audit({...})` calls in `server/src` pass; `redaction-sinks.enumeration`
   * re-derives that set from disk and fails if a new one appears unclassified.
   */
  const AUDIT_COUNT_KEYS = [
    "tokens", // analysis/orchestrator.ts, spec-kit/commands/runner.ts
    "totalTokens", // hooks/builtin-handlers.ts, routes/discussions.ts
    "promptTokens", // hooks/builtin-handlers.ts
    "completionTokens", // hooks/builtin-handlers.ts
    "inputTokens", // agents/pr-reviewer/pr-audit.ts
    "outputTokens", // agents/pr-reviewer/pr-audit.ts
    "maxTokens", // analysis/orchestrator.ts
    "maxOutputTokens", // analysis/orchestrator.ts
  ];

  it.each(AUDIT_COUNT_KEYS)("keeps %s when it carries a number", (key) => {
    expect(r({ [key]: 4096 })[key]).toBe(4096);
  });

  it("keeps a count of zero and a count that is absent", () => {
    // `0` and `null`/`undefined` are the cases a truthiness-based narrowing
    // would silently blank; a run that spent nothing is still an audit fact.
    expect(r({ totalTokens: 0 }).totalTokens).toBe(0);
    expect(r({ totalTokens: null }).totalTokens).toBeNull();
    expect(r({ promptTokens: undefined }).promptTokens).toBeUndefined();
  });

  it("normalises separator and case variants the way the shared predicate does", () => {
    expect(r({ prompt_tokens: 5 }).prompt_tokens).toBe(5);
    expect(r({ "PROMPT-TOKENS": 5 })["PROMPT-TOKENS"]).toBe(5);
  });

  it("agrees with the shared predicate on every key it was asked about", () => {
    // The sink must not re-implement the exemption. If `audit-service.ts` ever
    // grows its own copy, these two disagree on the first key that drifts.
    for (const key of AUDIT_COUNT_KEYS) {
      expect(isTokenCountExempt(key, 1), `${key} should be exempt`).toBe(true);
      expect(r({ [key]: 1 })[key]).toBe(1);
    }
    for (const key of ["accessToken", "tokenId", "someNewToken"]) {
      expect(isTokenCountExempt(key, 1), `${key} must not be exempt`).toBe(false);
      expect(r({ [key]: 1 })[key]).toBe(REDACTED);
    }
  });

  it("draws its count keys from the shared allowlist, not a local copy", () => {
    const allowlist = tokenCountMetaKeys();
    const normalize = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const key of AUDIT_COUNT_KEYS) {
      expect(allowlist.has(normalize(key)), `${key} missing from the shared allowlist`).toBe(true);
    }
  });
});

describe("audit sink — the persisted row, end to end (#1268)", () => {
  it("carries counts in the clear and credentials redacted through buildAuditLogData", () => {
    // Feed the object a production caller actually builds, not a reconstruction
    // of its key names — #1263 found two keys a call-site grep had missed.
    const data = buildAuditLogData({
      actorId: "u1",
      action: "custom_agent.invoked",
      targetType: "custom_agent",
      targetId: "ag1",
      metadata: {
        projectId: "p1",
        outcome: "success",
        promptTokens: 11,
        completionTokens: 22,
        totalTokens: 33,
        authorization: "Bearer leaked",
        accessToken: "sk-ant-api03-leaked",
      },
    });
    const meta = JSON.parse(data.metadata as string) as Record<string, unknown>;
    expect(meta.promptTokens).toBe(11);
    expect(meta.completionTokens).toBe(22);
    expect(meta.totalTokens).toBe(33);
    expect(meta.authorization).toBe(REDACTED);
    expect(meta.accessToken).toBe(REDACTED);
    expect(JSON.stringify(meta)).not.toContain("sk-ant-api03-leaked");
  });

  it("redacts deep-audit args and result the same way", () => {
    const data = buildAuditLogData({
      actorId: null,
      action: "ai.chat",
      targetType: "ai_session",
      targetId: "s1",
      args: { model: "claude", maxTokens: 8192, apiKey: "sk-leaked" },
      result: { totalTokens: 512, refresh_token: "rt-leaked" },
      deepAudit: true,
    });
    const meta = JSON.parse(data.metadata as string) as {
      args: Record<string, unknown>;
      result: Record<string, unknown>;
    };
    expect(meta.args.maxTokens).toBe(8192);
    expect(meta.args.apiKey).toBe(REDACTED);
    expect(meta.result.totalTokens).toBe(512);
    expect(meta.result.refresh_token).toBe(REDACTED);
  });

  it("changes the args hash when a count changes — the hash is over the real value", () => {
    // Before #1268 both runs hashed `{"totalTokens":"[REDACTED]"}`, so two
    // materially different runs produced the same argsHash. That is the
    // integrity cost of blanking a count in a *persisted* record.
    const mk = (n: number) =>
      buildAuditLogData({
        actorId: null,
        action: "a",
        targetType: "t",
        targetId: "1",
        args: { totalTokens: n },
      }).argsHash;
    expect(mk(1)).not.toBe(mk(2));
  });
});

/**
 * #85 — this sink does NOT serialise an `Error`, and that is the policy.
 *
 * `ERROR_SERIALISATION_POLICY: reduce-at-call-site`. #68 taught the logger to
 * serialise `name` / `message` / `stack` / `cause`; #85 added an aggregate's
 * `errors`. The identical `Object.entries` rebuild is here, and here the answer
 * is the opposite one: `AuditLog` rows are retained compliance evidence that is
 * exported, a stack carries absolute server paths, and a `cause` chain can drag
 * a whole provider payload into a row nobody re-reads. Callers reduce to
 * `.message` / `.code` at the boundary instead —
 * `redaction-sinks.enumeration.test.ts` re-checks that they all still do.
 *
 * These assertions exist so the policy is executable rather than a comment: a
 * later copy of the #68 repair into this file turns them red and sends the
 * author to `docs/decisions/0016-error-serialisation-in-the-persisting-sinks.md`
 * instead of landing a stack in a compliance row by analogy.
 */
describe("audit sink — Errors are reduced at the call site, not serialised here (#85)", () => {
  it("does not persist name, message, stack, cause or aggregate sub-errors", () => {
    const out = r({ err: new Error("provider refused: /srv/metis/secrets.env") });
    const err = out.err as Record<string, unknown>;
    expect(Object.keys(err)).toEqual([]);
    for (const dropped of ["name", "message", "stack", "cause", "errors"]) {
      expect(err[dropped], `${dropped} must not reach a persisted audit row`).toBeUndefined();
    }
    expect(JSON.stringify(out)).not.toContain("/srv/metis");
  });

  it("drops an AggregateError's sub-errors too", () => {
    const out = r({
      err: new AggregateError([new Error("a: /srv/one"), new Error("b: /srv/two")], "all failed"),
    });
    expect(JSON.stringify(out)).not.toContain("/srv/");
    expect((out.err as Record<string, unknown>).errors).toBeUndefined();
  });

  it("still redacts a credential hung off an error as an own enumerable property", () => {
    // The other direction: whatever an Error DOES carry enumerably is walked by
    // the same key rules as any other object, so the policy is "record less",
    // never "skip redaction".
    const out = r({
      err: Object.assign(new Error("boom"), {
        status: 402,
        accessToken: "opaque-credential-value-for-tests",
        requestId: "req-7",
      }),
    });
    const err = out.err as Record<string, unknown>;
    expect(err.status).toBe(402);
    expect(err.requestId).toBe("req-7");
    expect(err.accessToken).toBe(REDACTED);
  });
});
