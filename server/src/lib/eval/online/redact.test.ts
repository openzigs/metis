/**
 * Issue #1321 — the privacy pass on sampled live traffic.
 */
import { describe, expect, it } from "vitest";
import { digest, MAX_CONTEXTS, redactCandidate, type LiveRunCandidate } from "./redact.js";

const candidate = (over: Partial<LiveRunCandidate> = {}): LiveRunCandidate => ({
  surface: "chat",
  question: "hello",
  answer: "hi",
  contexts: [],
  ...over,
});

describe("redactCandidate", () => {
  it("redacts PII in the question, the answer and every context", () => {
    const out = redactCandidate(
      candidate({
        question: "email alice@example.com about it",
        answer: "call 555-123-4567 or use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
        contexts: ["ssn 123-45-6789", "clean context"],
      }),
      4000,
    );
    expect(out.question).toBe("email [REDACTED:email] about it");
    expect(out.answer).not.toContain("555-123-4567");
    expect(out.answer).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef");
    expect(out.contexts[0]).not.toContain("123-45-6789");
    expect(out.contexts[1]).toBe("clean context");
    expect(out.redactionHits).toBe(4);
  });

  it("reports zero redaction hits on clean text", () => {
    const out = redactCandidate(
      candidate({ question: "what is a widget", answer: "a thing" }),
      100,
    );
    expect(out.redactionHits).toBe(0);
  });

  it("does not count a literal [REDACTED: written by the user as a hit", () => {
    const out = redactCandidate(candidate({ question: "why does it say [REDACTED:email]?" }), 100);
    expect(out.redactionHits).toBe(0);
  });

  it("redacts BEFORE truncating, so a PII token straddling the cut is still caught", () => {
    // The filler alternates non-word characters so it cannot be swallowed into
    // the email's local part (`[\w.+-]+@`), and the 42-char cut lands mid-domain
    // at "alice@exampl" — a fragment the email pattern does NOT match, because it
    // requires a dot after the @. Truncate-then-redact therefore leaves the local
    // part in the clear; redact-then-truncate replaces it first.
    const filler = "z ".repeat(15);
    const out = redactCandidate(candidate({ question: `${filler}alice@example.com${filler}` }), 42);
    expect(out.question).toContain("[REDACTED");
    expect(out.question).not.toContain("alice@");
    expect(out.question).toHaveLength(42);
  });

  it("truncates each field to maxChars", () => {
    const out = redactCandidate(
      candidate({
        question: "q".repeat(500),
        answer: "w".repeat(500),
        contexts: ["z".repeat(500)],
      }),
      50,
    );
    expect(out.question).toHaveLength(50);
    expect(out.answer).toHaveLength(50);
    expect(out.contexts[0]).toHaveLength(50);
  });

  it("caps the number of contexts carried into scoring", () => {
    const out = redactCandidate(
      candidate({ contexts: Array.from({ length: 40 }, (_, i) => `c${i}`) }),
      100,
    );
    expect(out.contexts).toHaveLength(MAX_CONTEXTS);
  });

  it("tolerates missing fields", () => {
    const out = redactCandidate({ surface: "analysis" } as unknown as LiveRunCandidate, 100);
    expect(out).toEqual({ question: "", answer: "", contexts: [], redactionHits: 0 });
  });
});

describe("digest", () => {
  it("is a stable sha256 hex digest", () => {
    expect(digest("hello")).toMatch(/^[a-f0-9]{64}$/);
    expect(digest("hello")).toBe(digest("hello"));
    expect(digest("hello")).not.toBe(digest("hello "));
  });
});
