import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactRows, redactString, redactValue } from "../src/lib/connectors/pii-redactor.js";

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.PII_REDACT_DISABLE_PATTERNS;
});
afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("redactString", () => {
  it("redacts emails", () => {
    expect(redactString("contact alice@example.com please")).toContain("[REDACTED:email]");
  });

  it("redacts SSNs", () => {
    expect(redactString("SSN 123-45-6789")).toContain("[REDACTED:ssn]");
  });

  it("redacts valid Luhn credit cards but leaves invalid ones alone", () => {
    // 4242 4242 4242 4242 — Stripe's classic test PAN, passes Luhn.
    expect(redactString("4242 4242 4242 4242")).toContain("[REDACTED:cc]");
    // 0000 0000 0000 0001 — fails Luhn (sum=1).
    expect(redactString("0000 0000 0000 0001")).toBe("0000 0000 0000 0001");
  });

  it("redacts Bearer tokens", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnopqrstuv")).toContain(
      "[REDACTED:token]",
    );
  });

  it("redacts JWTs", () => {
    expect(redactString("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM")).toContain("[REDACTED:jwt]");
  });

  it("redacts GitHub PATs", () => {
    expect(redactString("token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain(
      "[REDACTED:github_pat]",
    );
  });

  it("redacts AWS access keys", () => {
    expect(redactString("AKIAIOSFODNN7EXAMPLE used")).toContain("[REDACTED:aws_key]");
  });

  it("redacts long hex secrets that are NOT common hash lengths", () => {
    // 50-char hex is neither MD5/SHA-1/SHA-256/SHA-512 — treat as a secret.
    expect(redactString("token=" + "a".repeat(50))).toContain("[REDACTED:secret]");
  });

  it("L3 — leaves 40-char hex (git commit SHA) alone", () => {
    const sha = "a".repeat(40);
    expect(redactString(`hash=${sha}`)).toBe(`hash=${sha}`);
  });

  it("L3 — leaves 32/64/128-char hex (md5/sha-256/sha-512) alone", () => {
    expect(redactString("md5=" + "f".repeat(32))).not.toContain("[REDACTED:secret]");
    expect(redactString("sha=" + "f".repeat(64))).not.toContain("[REDACTED:secret]");
    expect(redactString("sha=" + "f".repeat(128))).not.toContain("[REDACTED:secret]");
  });

  it("L3 — leaves long hex preceded by context word (commit:, sha-1=, git ) alone", () => {
    expect(redactString("commit: " + "a".repeat(50))).not.toContain("[REDACTED:secret]");
    expect(redactString("sha-1=" + "a".repeat(70))).not.toContain("[REDACTED:secret]");
    expect(redactString("git " + "a".repeat(50))).not.toContain("[REDACTED:secret]");
  });

  it("respects PII_REDACT_DISABLE_PATTERNS", () => {
    process.env.PII_REDACT_DISABLE_PATTERNS = "email,phone";
    const out = redactString("alice@example.com 555-123-4567 SSN 123-45-6789");
    expect(out).toContain("alice@example.com");
    expect(out).toContain("555-123-4567");
    expect(out).toContain("[REDACTED:ssn]");
  });

  it("noop on empty input", () => {
    expect(redactString("")).toBe("");
  });
});

describe("redactValue", () => {
  it("walks objects and arrays", () => {
    const result = redactValue({
      user: { email: "x@y.com" },
      tags: ["plain", "alice@example.com"],
    }) as { user: { email: string }; tags: string[] };
    expect(result.user.email).toContain("[REDACTED:email]");
    expect(result.tags[1]).toContain("[REDACTED:email]");
    expect(result.tags[0]).toBe("plain");
  });

  it("leaves primitives alone", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
    expect(redactValue(true)).toBe(true);
  });

  it("guards depth and cycles", () => {
    const a: Record<string, unknown> = { name: "alice@example.com" };
    a.self = a;
    const out = redactValue(a) as Record<string, unknown>;
    expect(out.name).toContain("[REDACTED:email]");
  });
});

describe("redactRows", () => {
  it("redacts each row independently", () => {
    const out = redactRows([
      { email: "a@b.com", id: 1 },
      { email: "c@d.com", id: 2 },
    ]);
    expect(out[0].email).toContain("[REDACTED:email]");
    expect(out[1].email).toContain("[REDACTED:email]");
  });
});
