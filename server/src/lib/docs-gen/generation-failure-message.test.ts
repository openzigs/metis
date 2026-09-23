/**
 * #52 — a failed generation's `errorMessage` is always one of a fixed set of
 * user-safe strings, never the raw exception text.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATION_BUDGET_EXCEEDED_MESSAGE,
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_AUTH_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
  GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
  GENERATION_PROVIDER_SLOW_MESSAGE,
  GENERATION_PROVIDER_TLS_MESSAGE,
  GENERATION_PROVIDER_DROPPED_MESSAGE,
  generationFailureMessage,
  isConnectionDropped,
  publicDocWarnings,
  publicGenerationErrorMessage,
} from "./generation-failure-message.js";
import { GENERATION_INTERRUPTED_MESSAGE } from "./interrupted-generations.js";
import { AIError, AIProviderError } from "../ai/errors.js";
import { BudgetExceededError } from "../finops/budget-enforcer.js";

const SECRET =
  'deepseek returned 500: {"error":"boom"} at /srv/metis/server/src/lib/x.ts:12 SELECT * FROM "User"';

describe("generationFailureMessage", () => {
  it("never echoes an unrecognised error", () => {
    const msg = generationFailureMessage(new Error(SECRET));
    expect(msg).toBe(GENERATION_FAILED_MESSAGE);
    expect(msg).not.toContain("/srv");
    expect(msg).not.toContain("SELECT");
  });

  it("handles non-Error throws", () => {
    expect(generationFailureMessage(undefined)).toBe(GENERATION_FAILED_MESSAGE);
    expect(generationFailureMessage({ weird: true })).toBe(GENERATION_FAILED_MESSAGE);
  });

  it("keeps a provider's 402 Insufficient Balance recognisable", () => {
    // The OpenAI-compatible provider's own shape (bedrock-direct-provider.ts).
    const raw = new Error(
      'deepseek returned 402: {"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
    );
    const msg = generationFailureMessage(raw);
    expect(msg).toBe(GENERATION_PROVIDER_BALANCE_MESSAGE);
    expect(msg).toMatch(/402 Insufficient Balance/);
    expect(msg).not.toContain("unknown_error");
    expect(generationFailureMessage(new AIProviderError("anthropic chat failed", 402))).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
    expect(generationFailureMessage(new Error("402 Insufficient Balance"))).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
    expect(generationFailureMessage(new Error("insufficient_quota"))).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
  });

  it("tells the project budget apart from the provider balance", () => {
    expect(generationFailureMessage(new BudgetExceededError(1_000, 900))).toBe(
      GENERATION_BUDGET_EXCEEDED_MESSAGE,
    );
  });

  it("recognises rate limiting", () => {
    expect(generationFailureMessage(new AIProviderError("slow down", 429))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
    expect(generationFailureMessage(new Error("bedrock returned 429: ThrottlingException"))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
    expect(generationFailureMessage(new Error('openai returned 429: {"error":{}}'))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
    expect(generationFailureMessage(new Error("Rate limit reached for requests"))).toBe(
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
    );
  });

  it("recognises rejected credentials", () => {
    expect(generationFailureMessage(new AIProviderError("denied", 401))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
    expect(generationFailureMessage(new Error("openai returned 403: forbidden"))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
    expect(generationFailureMessage(new Error("Incorrect API key provided: sk-abc"))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
  });

  it("names an unreachable provider host instead of the generic message", () => {
    // What undici's fetch throws when a local Ollama host is down: the message
    // is only "fetch failed" and the OS error hangs off `.cause`.
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
        code: "ECONNREFUSED",
      }),
    });
    const msg = generationFailureMessage(refused);
    expect(msg).toBe(GENERATION_PROVIDER_UNREACHABLE_MESSAGE);
    expect(msg).not.toContain("127.0.0.1");
    expect(msg).not.toContain("11434");
    // The cause code alone, with an opaque message.
    const dns = new Error("request to provider failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND ollama.internal"), {
        code: "ENOTFOUND",
      }),
    });
    expect(generationFailureMessage(dns)).toBe(GENERATION_PROVIDER_UNREACHABLE_MESSAGE);
    expect(generationFailureMessage(Object.assign(new Error("x"), { code: "EHOSTUNREACH" }))).toBe(
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
    );
    // Stored text (a pre-#67 section-failed warning) carries only the words.
    expect(generationFailureMessage("TypeError: fetch failed")).toBe(
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
    );
    expect(generationFailureMessage("connect ECONNREFUSED 10.0.0.5:11434")).toBe(
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
    );
  });

  it("classifies a provider status before a connection failure", () => {
    expect(generationFailureMessage(new AIProviderError("fetch failed", 401))).toBe(
      GENERATION_PROVIDER_AUTH_MESSAGE,
    );
  });

  it("does not read an unrelated mention of a network word as unreachable", () => {
    expect(generationFailureMessage(new Error("prefetch failed for module cache"))).toBe(
      GENERATION_FAILED_MESSAGE,
    );
  });

  it("does not read a bare number in a message as a status", () => {
    expect(generationFailureMessage(new Error("parsed 402 tables in 429 ms"))).toBe(
      GENERATION_FAILED_MESSAGE,
    );
  });
});

/** undici's shape: an outer TypeError whose `.cause` carries the real code. */
function undiciError(outer: string, code: string, inner = "x", extra: object = {}): TypeError {
  return new TypeError(outer, { cause: Object.assign(new Error(inner), { code, ...extra }) });
}

// #114 — "fetch failed" is undici's wrapper text for EVERY transport failure, so
// deciding on it alone told the operator of a slow-but-working local model that
// the host was unreachable. When a code is present it decides; text is only the
// fallback for stored strings and code-less errors.
describe("generationFailureMessage — transport failures are classified by code (#114)", () => {
  it("a headers timeout is a slow model, not an unreachable host", () => {
    const err = undiciError("fetch failed", "UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error");
    expect(generationFailureMessage(err)).toBe(GENERATION_PROVIDER_SLOW_MESSAGE);
  });

  it("a body timeout mid-response is a slow model too", () => {
    const err = undiciError("terminated", "UND_ERR_BODY_TIMEOUT", "Body Timeout Error");
    expect(generationFailureMessage(err)).toBe(GENERATION_PROVIDER_SLOW_MESSAGE);
  });

  it("a TLS verification failure names the certificate", () => {
    for (const code of [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      expect(generationFailureMessage(undiciError("fetch failed", code)), code).toBe(
        GENERATION_PROVIDER_TLS_MESSAGE,
      );
    }
  });

  it("a reset connection is a drop, not an unreachable host", () => {
    const err = undiciError("fetch failed", "ECONNRESET", "read ECONNRESET");
    expect(generationFailureMessage(err)).toBe(GENERATION_PROVIDER_DROPPED_MESSAGE);
  });

  it("undici's `TypeError: terminated` (the socket closed mid-stream) is a drop", () => {
    const socket = undiciError("terminated", "UND_ERR_SOCKET", "other side closed");
    expect(generationFailureMessage(socket)).toBe(GENERATION_PROVIDER_DROPPED_MESSAGE);
    // Observed live 2026-09-23 against Ollama: the bare form, no code at all.
    expect(generationFailureMessage(new TypeError("terminated"))).toBe(
      GENERATION_PROVIDER_DROPPED_MESSAGE,
    );
    // A pre-#114 stored warning carries only the words.
    expect(generationFailureMessage("TypeError: terminated")).toBe(
      GENERATION_PROVIDER_DROPPED_MESSAGE,
    );
  });

  it("a read-side ETIMEDOUT is a drop; only a connect ETIMEDOUT is unreachable", () => {
    expect(
      generationFailureMessage(undiciError("fetch failed", "ETIMEDOUT", "read ETIMEDOUT")),
    ).toBe(GENERATION_PROVIDER_DROPPED_MESSAGE);
    expect(
      generationFailureMessage(
        undiciError("fetch failed", "ETIMEDOUT", "connect ETIMEDOUT 10.0.0.5:11434", {
          syscall: "connect",
        }),
      ),
    ).toBe(GENERATION_PROVIDER_UNREACHABLE_MESSAGE);
    expect(generationFailureMessage(undiciError("fetch failed", "UND_ERR_CONNECT_TIMEOUT"))).toBe(
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
    );
  });

  it("an unrecognised code decides too: `fetch failed` text no longer overrides it", () => {
    expect(generationFailureMessage(undiciError("fetch failed", "ERR_INVALID_URL"))).toBe(
      GENERATION_FAILED_MESSAGE,
    );
  });

  it("the declared AI_PROVIDER_UNREACHABLE code reads as unreachable", () => {
    expect(generationFailureMessage(new AIError("AI_PROVIDER_UNREACHABLE", "host down", 503))).toBe(
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
    );
  });

  it("every transport class gets a DISTINCT message, and only connect-phase says unreachable", () => {
    const messages = [
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
      GENERATION_PROVIDER_SLOW_MESSAGE,
      GENERATION_PROVIDER_TLS_MESSAGE,
      GENERATION_PROVIDER_DROPPED_MESSAGE,
    ];
    expect(new Set(messages).size).toBe(4);
    for (const m of messages.slice(1)) expect(m).not.toMatch(/could not be reached|unreachable/i);
    // Each is in the safe vocabulary, so a stored copy passes through unchanged.
    for (const m of messages) expect(generationFailureMessage(m)).toBe(m);
  });

  it("stored text falls back by class when there is no code", () => {
    expect(generationFailureMessage("HeadersTimeoutError: Headers Timeout Error")).toBe(
      GENERATION_PROVIDER_SLOW_MESSAGE,
    );
    expect(generationFailureMessage("Error: read ECONNRESET")).toBe(
      GENERATION_PROVIDER_DROPPED_MESSAGE,
    );
    expect(generationFailureMessage("Error: unable to verify the first certificate")).toBe(
      GENERATION_PROVIDER_TLS_MESSAGE,
    );
  });

  it("#111's first-token timeout reads as a slow model, never as a drop", async () => {
    const { FirstTokenTimeoutError } = await import("../ai/providers/bedrock-direct-provider.js");
    const err = new FirstTokenTimeoutError(
      600_000,
      520_000,
      2,
      "local-gemma stream stalled — no first token within 600000ms for a prompt of 520000 chars across 2 message(s) (connected, awaiting the first token)",
    );
    expect(generationFailureMessage(err)).toBe(GENERATION_PROVIDER_SLOW_MESSAGE);
    expect(isConnectionDropped(err)).toBe(false);
    // A stored copy of its text classifies the same way.
    expect(generationFailureMessage(`Error: ${err.message}`)).toBe(
      GENERATION_PROVIDER_SLOW_MESSAGE,
    );
  });

  it("does not read a word that merely contains `terminated` as a drop", () => {
    expect(generationFailureMessage(new Error("worker terminated by operator"))).toBe(
      GENERATION_FAILED_MESSAGE,
    );
  });
});

describe("isConnectionDropped (#114)", () => {
  it("is true only for a mid-response drop", () => {
    expect(isConnectionDropped(new TypeError("terminated"))).toBe(true);
    expect(isConnectionDropped(undiciError("terminated", "UND_ERR_SOCKET"))).toBe(true);
    expect(isConnectionDropped(undiciError("fetch failed", "ECONNRESET"))).toBe(true);
    expect(isConnectionDropped(undiciError("fetch failed", "ECONNREFUSED"))).toBe(false);
    expect(isConnectionDropped(undiciError("terminated", "UND_ERR_BODY_TIMEOUT"))).toBe(false);
    expect(isConnectionDropped(new Error("boom"))).toBe(false);
  });
});

describe("publicGenerationErrorMessage", () => {
  it("passes every safe message through unchanged, including the #53 restart message", () => {
    for (const safe of [
      GENERATION_INTERRUPTED_MESSAGE,
      GENERATION_FAILED_MESSAGE,
      GENERATION_PROVIDER_BALANCE_MESSAGE,
      GENERATION_BUDGET_EXCEEDED_MESSAGE,
      GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
      GENERATION_PROVIDER_AUTH_MESSAGE,
      GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
    ]) {
      expect(publicGenerationErrorMessage("failed", safe)).toBe(safe);
    }
  });

  it("sanitises raw text a pre-#52 failed row still holds", () => {
    expect(publicGenerationErrorMessage("failed", `Error: ${SECRET}`)).toBe(
      GENERATION_FAILED_MESSAGE,
    );
    expect(publicGenerationErrorMessage("failed", "Error: deepseek returned 402: {...}")).toBe(
      GENERATION_PROVIDER_BALANCE_MESSAGE,
    );
  });

  it("returns null for no message and leaves a non-failed row's field alone", () => {
    expect(publicGenerationErrorMessage("failed", null)).toBeNull();
    expect(publicGenerationErrorMessage("failed", undefined)).toBeNull();
    const legacyWarnings = JSON.stringify([{ kind: "ungrounded", message: "m" }]);
    expect(publicGenerationErrorMessage("degraded", legacyWarnings)).toBe(legacyWarnings);
  });
});

/**
 * #67 — the READ arm. A row persisted before #67 still carries up to 300
 * characters of `String(err)` inside a `section-failed` warning message, in the
 * `warnings` JSON column that `GET /projects/:projectId/docs/:docId` returns.
 * `publicDocWarnings` re-derives the detail of any such warning through the
 * fixed vocabulary, and leaves everything else exactly as persisted.
 */
describe("publicDocWarnings", () => {
  const legacy = (message: string) => [
    { kind: "section-failed", section: "Business Rules", message, severity: "error" },
  ];

  it("sanitises a legacy section-failed warning that echoes the exception", () => {
    const out = publicDocWarnings(
      legacy(`Section "Business Rules" could not be generated: Error: ${SECRET}.`),
    ) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0].message).not.toContain("deepseek");
    expect(out[0].message).not.toContain("/srv/metis");
    expect(out[0].message).not.toContain("SELECT");
    expect(out[0].message).toContain(GENERATION_FAILED_MESSAGE);
    expect(out[0].message).toContain('Section "Business Rules" could not be generated');
    // Still an error-severity degradation for the same section.
    expect(out[0].severity).toBe("error");
    expect(out[0].section).toBe("Business Rules");
    expect(out[0].detailSafe).toBe(true);
  });

  it("keeps a legacy balance failure recognisable as a balance problem", () => {
    const out = publicDocWarnings(
      legacy('Section "X" could not be generated: Error: deepseek returned 402: {"e":1}.'),
    ) as Array<Record<string, unknown>>;
    expect(out[0].message).toContain(GENERATION_PROVIDER_BALANCE_MESSAGE);
    expect(out[0].message).not.toContain("deepseek");
  });

  it("leaves a post-#67 warning untouched, message and all", () => {
    const safe = [
      {
        kind: "section-failed",
        section: "Table Reference",
        message: 'Section "Table Reference" could not be generated: 0 of 641 tables described.',
        severity: "error",
        detailSafe: true,
      },
    ];
    expect(publicDocWarnings(safe)).toEqual(safe);
  });

  it("leaves every other warning kind untouched, numeric fields included", () => {
    const others = [
      {
        kind: "section-ungrounded",
        section: "Workflows",
        message: 'Section "Workflows": 41% of claims are grounded.',
        severity: "warning",
        ratio: 0.41,
        threshold: 0.6,
        tier: "reconstruction",
      },
      { kind: "no-modules", section: "Document", message: "none qualified", severity: "warning" },
    ];
    expect(publicDocWarnings(others)).toEqual(others);
  });

  it("passes through shapes that are not a warnings array", () => {
    expect(publicDocWarnings(null)).toBeNull();
    expect(publicDocWarnings(undefined)).toBeUndefined();
    expect(publicDocWarnings("legacy string")).toBe("legacy string");
    expect(publicDocWarnings({ kind: "section-failed" })).toEqual({ kind: "section-failed" });
    // Non-object members survive a mixed array rather than being dropped.
    expect(publicDocWarnings([1, null, "x"])).toEqual([1, null, "x"]);
  });

  it("sanitises a legacy warning whose message field is missing or not a string", () => {
    const out = publicDocWarnings([
      { kind: "section-failed", section: "Y", severity: "error" },
      { kind: "section-failed", section: "Z", message: 42, severity: "error" },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].message).toContain(GENERATION_FAILED_MESSAGE);
    expect(out[1].message).toContain(GENERATION_FAILED_MESSAGE);
    expect(out[1].message).not.toContain("42");
  });
});

/**
 * #86 — the LEGACY `errorMessage` column, the last arm of the same exposure.
 *
 * #52 sanitised a `failed` row's `errorMessage`; #67 sanitised the `warnings`
 * column. A row degraded before the #252 migration stored its `DocWarning[]`
 * JSON in `errorMessage` instead, built by the pre-#67
 * `sectionFailedWarning(label, String(err))` — so the exception text is
 * embedded in that blob, `publicGenerationErrorMessage` returned it verbatim
 * for any non-`failed` status, and the UI's `resolveDocWarnings` legacy
 * fallback parsed and rendered it. The exposure #67 closed survived intact for
 * every document generated before #252.
 *
 * Two things must hold together: nothing echoed, AND the blob still parses into
 * the `DocWarning[]` shape the UI's legacy fallback requires (it keeps only
 * entries with a string `message`), so sanitising it does not silently blank
 * the banner instead.
 */
const LEGACY_WARNING_BLOB = JSON.stringify([
  {
    kind: "section-failed",
    section: "Data Model",
    // The pre-#67 builder: `String(err)` straight into the message.
    message: `Section "Data Model" could not be generated: ${SECRET}.`,
    severity: "error",
  },
]);

describe("publicGenerationErrorMessage — legacy errorMessage warning JSON (#86)", () => {
  it("does not echo the exception embedded in a pre-#252 degraded row", () => {
    const out = publicGenerationErrorMessage("degraded", LEGACY_WARNING_BLOB);
    expect(out).not.toBeNull();
    expect(out).not.toContain("/srv");
    expect(out).not.toContain("SELECT");
    expect(out).not.toContain("deepseek returned 500");
    expect(out).not.toContain('{"error":"boom"}');
  });

  it("keeps the blob parseable as the DocWarning[] the UI legacy fallback reads", () => {
    const parsed: unknown = JSON.parse(
      publicGenerationErrorMessage("degraded", LEGACY_WARNING_BLOB)!,
    );
    expect(Array.isArray(parsed)).toBe(true);
    const warnings = parsed as Array<Record<string, unknown>>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("section-failed");
    expect(warnings[0].section).toBe("Data Model");
    expect(warnings[0].severity).toBe("error");
    // The UI keeps only entries whose `message` is a string — sanitising must
    // not blank the banner it was meant to make safe.
    expect(typeof warnings[0].message).toBe("string");
    expect(warnings[0].message).toContain(GENERATION_FAILED_MESSAGE);
    expect(warnings[0].detailSafe).toBe(true);
  });

  it("keeps a recognisable provider failure recognisable through the legacy column", () => {
    const blob = JSON.stringify([
      {
        kind: "section-failed",
        section: "Workflows",
        message: 'Section "Workflows" could not be generated: deepseek returned 402: {"x":1}.',
        severity: "error",
      },
    ]);
    const out = publicGenerationErrorMessage("degraded", blob)!;
    expect(out).toContain(GENERATION_PROVIDER_BALANCE_MESSAGE);
    expect(out).not.toContain('{"x":1}');
  });

  it("sanitises a non-JSON legacy errorMessage on a non-failed row", () => {
    // The UI's `catch` arm renders this string as a single warning verbatim.
    expect(publicGenerationErrorMessage("degraded", `Error: ${SECRET}`)).toBe(
      GENERATION_FAILED_MESSAGE,
    );
    expect(
      publicGenerationErrorMessage("degraded", "Error: deepseek returned 429: slow down"),
    ).toBe(GENERATION_PROVIDER_RATE_LIMITED_MESSAGE);
  });

  it("sanitises JSON that is not an array of warnings", () => {
    expect(publicGenerationErrorMessage("degraded", JSON.stringify({ raw: SECRET }))).toBe(
      GENERATION_FAILED_MESSAGE,
    );
    expect(publicGenerationErrorMessage("degraded", "null")).toBe(GENERATION_FAILED_MESSAGE);
  });

  it("leaves a post-#67 warning's METIS-authored detail intact", () => {
    // `detailSafe` is the discriminator: no pre-#67 row can carry it, so a
    // blob written after #67 keeps its own prose.
    const blob = JSON.stringify([
      {
        kind: "section-failed",
        section: "Data Model",
        message: 'Section "Data Model" could not be generated: 3 of 11 tables described.',
        severity: "error",
        detailSafe: true,
      },
    ]);
    expect(publicGenerationErrorMessage("degraded", blob)).toBe(blob);
  });

  it("leaves a warning kind that is never built from an exception untouched", () => {
    const blob = JSON.stringify([{ kind: "no-modules", message: "No modules found." }]);
    expect(publicGenerationErrorMessage("degraded", blob)).toBe(blob);
  });

  it("still returns null for no message", () => {
    expect(publicGenerationErrorMessage("degraded", null)).toBeNull();
    expect(publicGenerationErrorMessage("degraded", undefined)).toBeNull();
  });
});
