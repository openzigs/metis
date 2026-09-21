/**
 * Sub-issue #277 — user scope feature flag + per-user concurrency cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfgState = {
  booleans: new Map<string, boolean>(),
  numbers: new Map<string, number>(),
  strings: new Map<string, string>(),
};

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getBool: (k: string, def: boolean) => cfgState.booleans.get(k) ?? def,
    getNumber: (k: string, def: number) => cfgState.numbers.get(k) ?? def,
    get: (k: string) => cfgState.strings.get(k),
  }),
}));

import { assertUserScopeAllowed } from "../../../src/lib/mcp/validation.js";
import { MCPRegistryError } from "../../../src/lib/mcp/mcp-service-error.js";

beforeEach(() => {
  cfgState.booleans.clear();
  cfgState.numbers.clear();
  cfgState.strings.clear();
});

describe("assertUserScopeAllowed (#277)", () => {
  it("is a no-op for global scope", () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", false);
    expect(() => assertUserScopeAllowed({ scope: "global", actorUserId: "u" })).not.toThrow();
  });

  it("is a no-op for project scope", () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", false);
    expect(() => assertUserScopeAllowed({ scope: "project", actorUserId: "u" })).not.toThrow();
  });

  it("rejects user scope when flag is off", () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", false);
    try {
      assertUserScopeAllowed({ scope: "user", actorUserId: "u" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as MCPRegistryError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("USER_SCOPE_DISABLED");
    }
  });

  it("accepts user scope when flag is on", () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", true);
    expect(() => assertUserScopeAllowed({ scope: "user", actorUserId: "u" })).not.toThrow();
  });
});
