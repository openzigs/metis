/**
 * Sub-issue #274 — assertVaultEnv tunable enforcement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfgState = { booleans: new Map<string, boolean>(), strings: new Map<string, string>() };

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getBool: (k: string, def: boolean) => cfgState.booleans.get(k) ?? def,
    get: (k: string) => cfgState.strings.get(k),
    getNumber: (k: string, def: number) => def,
  }),
}));

import { assertVaultEnv } from "../../../src/lib/mcp/validation.js";
import { MCPRegistryError } from "../../../src/lib/mcp/mcp-service-error.js";

beforeEach(() => {
  cfgState.booleans.clear();
  cfgState.strings.clear();
});

describe("assertVaultEnv (#274)", () => {
  it("returns silently when MCP_REQUIRE_VAULT_ENV is false", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", false);
    expect(() => assertVaultEnv({ FOO: "plain" })).not.toThrow();
  });

  it("returns silently when env is null/undefined regardless of flag", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", true);
    expect(() => assertVaultEnv(null)).not.toThrow();
    expect(() => assertVaultEnv(undefined)).not.toThrow();
  });

  it("accepts an env where every value is a vault reference", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", true);
    expect(() => assertVaultEnv({ TOKEN: "${vault:t}", URL: "${vault:base-url}" })).not.toThrow();
  });

  it("rejects mixed vault + plaintext", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", true);
    expect(() => assertVaultEnv({ TOKEN: "${vault:t}", FOO: "plain" })).toThrow(MCPRegistryError);
  });

  it("rejects all-plaintext env with PLAINTEXT_ENV_FORBIDDEN", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", true);
    try {
      assertVaultEnv({ A: "1", B: "2" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPRegistryError);
      const e = err as MCPRegistryError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("PLAINTEXT_ENV_FORBIDDEN");
      expect(e.message).toContain("A");
      expect(e.message).toContain("B");
    }
  });

  it("rejects malformed vault refs (typos)", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", true);
    // Missing closing brace.
    expect(() => assertVaultEnv({ FOO: "${vault:bad" })).toThrow(MCPRegistryError);
    // Wrong scheme.
    expect(() => assertVaultEnv({ FOO: "${secret:t}" })).toThrow(MCPRegistryError);
  });

  it("accepts empty env object as a no-op", () => {
    cfgState.booleans.set("MCP_REQUIRE_VAULT_ENV", true);
    expect(() => assertVaultEnv({})).not.toThrow();
  });
});
