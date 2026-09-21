/**
 * Sub-issue #276 — admin-only trustLevel='trusted' promotion.
 */
import { describe, expect, it } from "vitest";

import { assertTrustPromotionAllowed } from "../../../src/lib/mcp/validation.js";
import { MCPRegistryError } from "../../../src/lib/mcp/mcp-service-error.js";

describe("assertTrustPromotionAllowed (#276)", () => {
  it("returns silently when requested is undefined", () => {
    expect(() =>
      assertTrustPromotionAllowed(undefined, { id: "u", role: "developer" }),
    ).not.toThrow();
  });

  it("returns silently when requested is 'untrusted'", () => {
    expect(() =>
      assertTrustPromotionAllowed("untrusted", { id: "u", role: "reader" }),
    ).not.toThrow();
  });

  it("admin can promote to trusted", () => {
    expect(() =>
      assertTrustPromotionAllowed("trusted", { id: "admin", role: "admin" }),
    ).not.toThrow();
  });

  it("coordinator (current mcp.manage holder) can promote", () => {
    expect(() =>
      assertTrustPromotionAllowed("trusted", { id: "c", role: "coordinator" }),
    ).not.toThrow();
  });

  it("developer cannot promote — 400 TRUST_LEVEL_REQUIRES_ADMIN", () => {
    try {
      assertTrustPromotionAllowed("trusted", { id: "u", role: "developer" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as MCPRegistryError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("TRUST_LEVEL_REQUIRES_ADMIN");
    }
  });

  it("reader cannot promote", () => {
    expect(() => assertTrustPromotionAllowed("trusted", { id: "r", role: "reader" })).toThrow(
      MCPRegistryError,
    );
  });

  it("actor with no role cannot promote", () => {
    expect(() => assertTrustPromotionAllowed("trusted", { id: "u" })).toThrow(MCPRegistryError);
  });
});
