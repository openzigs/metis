/**
 * Epic #129 (#145) — an agent's approval override can only TIGHTEN the
 * session's policy; malformed input is refused; an unreadable stored value
 * fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalOverrideError,
  effectivePolicy,
  parseApprovalOverride,
  readStoredOverride,
} from "./policy.js";

const SESSION = { low: "auto", medium: "prompt-once", high: "always-prompt" } as const;

describe("effectivePolicy", () => {
  it("takes the stricter action per risk", () => {
    expect(effectivePolicy(SESSION, { low: "always-prompt", high: "deny" })).toEqual({
      low: "always-prompt",
      medium: "prompt-once",
      high: "deny",
    });
  });

  it("NEVER loosens: an override asking for less than the session is ignored", () => {
    expect(effectivePolicy(SESSION, { medium: "auto", high: "prompt-once" })).toEqual(SESSION);
    expect(
      effectivePolicy(
        { low: "deny", medium: "deny", high: "deny" },
        {
          low: "auto",
          medium: "auto",
          high: "auto",
        },
      ),
    ).toEqual({ low: "deny", medium: "deny", high: "deny" });
  });

  it("no override leaves the session policy as it is (a copy)", () => {
    const out = effectivePolicy(SESSION, null);
    expect(out).toEqual(SESSION);
    expect(out).not.toBe(SESSION);
  });
});

describe("parseApprovalOverride", () => {
  it("accepts per-risk actions and drops an empty object to null", () => {
    expect(parseApprovalOverride({ low: "prompt-once" })).toEqual({ low: "prompt-once" });
    expect(parseApprovalOverride({})).toBeNull();
    expect(parseApprovalOverride(null)).toBeNull();
    expect(parseApprovalOverride(undefined)).toBeNull();
  });

  it("rejects unknown risks, unknown actions and non-objects", () => {
    expect(() => parseApprovalOverride({ critical: "deny" })).toThrow(ApprovalOverrideError);
    expect(() => parseApprovalOverride({ low: "yolo" })).toThrow(ApprovalOverrideError);
    expect(() => parseApprovalOverride(["deny"])).toThrow(ApprovalOverrideError);
    expect(() => parseApprovalOverride("deny")).toThrow(ApprovalOverrideError);
    // A prototype key is data, not a risk level.
    expect(() => parseApprovalOverride(JSON.parse('{"__proto__": "deny"}'))).toThrow(
      ApprovalOverrideError,
    );
  });
});

describe("readStoredOverride", () => {
  it("reads a stored override", () => {
    expect(readStoredOverride('{"high":"deny"}')).toEqual({ high: "deny" });
    expect(readStoredOverride(null)).toBeNull();
  });

  it("fails CLOSED to prompt-on-everything when the stored value is unreadable", () => {
    const closed = { low: "always-prompt", medium: "always-prompt", high: "always-prompt" };
    expect(readStoredOverride("{not json")).toEqual(closed);
    expect(readStoredOverride('{"low":"nope"}')).toEqual(closed);
  });
});
