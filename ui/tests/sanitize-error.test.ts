/**
 * S4 (#145) — sanitizeErrorMessage / redactSecrets security tests.
 */
import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage, redactSecrets } from "@/lib/sanitize-error";
import { ApiError } from "@/lib/api-client";

describe("redactSecrets", () => {
  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s5d8F-abcDEF_ghij";
    expect(redactSecrets(`token ${jwt}`)).not.toContain(jwt);
    expect(redactSecrets(`token ${jwt}`)).toContain("[redacted]");
  });

  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abc123def456ghi789");
    expect(out).not.toContain("abc123def456ghi789");
    expect(out).toContain("[redacted]");
  });

  it("redacts provider API keys", () => {
    expect(redactSecrets("key sk-ABCDEFGHIJ1234567890")).toContain("[redacted]");
    expect(redactSecrets("key sk-ABCDEFGHIJ1234567890")).not.toContain("ABCDEFGHIJ1234567890");
  });

  it("redacts key=value secret pairs", () => {
    expect(redactSecrets('password="hunter2supersecret"')).toContain("password=[redacted]");
    expect(redactSecrets("api_key: myverysecretkeyvalue")).toContain("api_key=[redacted]");
  });

  it("redacts long high-entropy blobs", () => {
    const blob = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    expect(redactSecrets(`value ${blob}`)).toContain("[redacted]");
  });
});

describe("sanitizeErrorMessage", () => {
  it("returns a friendly fallback for non-error inputs", () => {
    expect(sanitizeErrorMessage(undefined)).toMatch(/something went wrong/i);
    expect(sanitizeErrorMessage(null)).toMatch(/something went wrong/i);
    expect(sanitizeErrorMessage({ weird: true })).toMatch(/something went wrong/i);
  });

  it("uses status-based copy for ApiErrors with empty messages", () => {
    expect(sanitizeErrorMessage(new ApiError(401, ""))).toMatch(/session has expired/i);
    expect(sanitizeErrorMessage(new ApiError(403, ""))).toMatch(/permission/i);
    expect(sanitizeErrorMessage(new ApiError(404, ""))).toMatch(/couldn't find/i);
    expect(sanitizeErrorMessage(new ApiError(429, ""))).toMatch(/too many requests/i);
    expect(sanitizeErrorMessage(new ApiError(500, ""))).toMatch(/server error/i);
    expect(sanitizeErrorMessage(new ApiError(418, ""))).toMatch(/could not be completed/i);
  });

  it("surfaces a safe ApiError message", () => {
    expect(sanitizeErrorMessage(new ApiError(400, "Project name is required"))).toBe(
      "Project name is required",
    );
  });

  it("NEVER renders stack traces", () => {
    const err = new Error("Boom happened");
    err.stack =
      "Error: Boom happened\n    at doThing (/srv/app/secret.ts:42:13)\n    at main (/srv/app/index.ts:1:1)";
    const msg = sanitizeErrorMessage(err);
    expect(msg).toBe("Boom happened");
    expect(msg).not.toContain("secret.ts");
    expect(msg).not.toContain("at ");
  });

  it("falls back when the first line itself looks like a stack frame/path", () => {
    expect(sanitizeErrorMessage("at handler (/srv/app/file.ts:10:2)")).toMatch(
      /something went wrong/i,
    );
    expect(sanitizeErrorMessage("/var/secrets/vault/token/value")).toMatch(/something went wrong/i);
  });

  it("redacts secrets embedded in the message", () => {
    const msg = sanitizeErrorMessage(
      new ApiError(500, "Upstream failed with token=eyJhbGciOiJ.IUzI1NiJ.s5d8Fabcd"),
    );
    expect(msg).not.toContain("eyJhbGciOiJ");
    expect(msg).toContain("[redacted]");
  });

  it("caps very long messages", () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const msg = sanitizeErrorMessage(new ApiError(400, long));
    expect(msg.length).toBeLessThanOrEqual(300);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("uses a custom fallback when provided", () => {
    expect(sanitizeErrorMessage(undefined, "nope")).toBe("nope");
  });
});
