/**
 * Issue #104 — per-server tool allowlist enforcement.
 */
import { describe, expect, it } from "vitest";
import {
  enforceAllowlist,
  isAllowed,
  McpToolDeniedError,
  parseAllowlist,
  serializeAllowlist,
} from "../src/lib/mcp/allowlist.js";

describe("parseAllowlist", () => {
  it("returns null for null/undefined/empty inputs", () => {
    expect(parseAllowlist(null)).toBeNull();
    expect(parseAllowlist(undefined)).toBeNull();
    expect(parseAllowlist("")).toBeNull();
    expect(parseAllowlist("[]")).toBeNull();
    expect(parseAllowlist([])).toBeNull();
  });
  it("parses JSON-encoded arrays", () => {
    expect(parseAllowlist(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
  });
  it("accepts a string array directly", () => {
    expect(parseAllowlist(["x", "y"])).toEqual(["x", "y"]);
  });
  it("returns null for malformed JSON", () => {
    expect(parseAllowlist("not-json")).toBeNull();
  });
});

describe("serializeAllowlist", () => {
  it("returns null for null / empty inputs", () => {
    expect(serializeAllowlist(null)).toBeNull();
    expect(serializeAllowlist([])).toBeNull();
  });
  it("dedupes and JSON-encodes the input", () => {
    expect(serializeAllowlist(["a", "a", "b"])).toBe(JSON.stringify(["a", "b"]));
  });
});

describe("isAllowed", () => {
  it("returns true when the allowlist is null or empty (= unrestricted)", () => {
    expect(isAllowed(null, "anything")).toBe(true);
    expect(isAllowed([], "anything")).toBe(true);
  });
  it("only allows tools present on the list", () => {
    expect(isAllowed(["read", "write"], "read")).toBe(true);
    expect(isAllowed(["read", "write"], "destroy")).toBe(false);
  });
});

describe("enforceAllowlist", () => {
  it("returns silently when allowed", () => {
    expect(() => enforceAllowlist("srv", "read", ["read"])).not.toThrow();
    expect(() => enforceAllowlist("srv", "anything", null)).not.toThrow();
  });
  it("throws McpToolDeniedError with reason 'not_on_allowlist' when denied", () => {
    expect.assertions(4);
    try {
      enforceAllowlist("srv-1", "destroy", ["read"]);
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolDeniedError);
      const e = err as McpToolDeniedError;
      expect(e.code).toBe("tool_denied");
      expect(e.reason).toBe("not_on_allowlist");
      expect(e.serverId).toBe("srv-1");
    }
  });
});
