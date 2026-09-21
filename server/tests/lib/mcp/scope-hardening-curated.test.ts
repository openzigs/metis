/**
 * Sub-issue #273 — assertCuratedSource enforcement and admin bypass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfgState = { booleans: new Map<string, boolean>() };

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getBool: (k: string, def: boolean) => cfgState.booleans.get(k) ?? def,
    get: () => undefined,
    getNumber: (_k: string, def: number) => def,
  }),
}));

import { assertCuratedSource } from "../../../src/lib/mcp/validation.js";
import { MCPRegistryError } from "../../../src/lib/mcp/mcp-service-error.js";

beforeEach(() => {
  cfgState.booleans.clear();
});

describe("assertCuratedSource (#273)", () => {
  it("returns silently when MCP_REQUIRE_CATALOG is false (any source)", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", false);
    expect(() =>
      assertCuratedSource("project", null, { id: "u", role: "developer" }),
    ).not.toThrow();
    expect(() =>
      assertCuratedSource("global", undefined, { id: "u", role: "reader" }),
    ).not.toThrow();
  });

  it("rejects project-scope without a source when flag is on", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    try {
      assertCuratedSource("project", null, { id: "u", role: "developer" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as MCPRegistryError;
      expect(e.status).toBe(403);
      expect(e.code).toBe("RAW_COMMAND_FORBIDDEN");
    }
  });

  it("accepts catalog source on project scope", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() =>
      assertCuratedSource(
        "project",
        { kind: "catalog", catalogId: "x", version: "1" },
        { id: "u", role: "developer" },
      ),
    ).not.toThrow();
  });

  it("accepts template source", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() =>
      assertCuratedSource(
        "project",
        { kind: "template", templateId: "t" },
        { id: "u", role: "developer" },
      ),
    ).not.toThrow();
  });

  it("accepts federation source", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() =>
      assertCuratedSource(
        "project",
        { kind: "federation", catalogId: "remote-x" },
        { id: "u", role: "developer" },
      ),
    ).not.toThrow();
  });

  it("admin global bypasses the curated check", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() => assertCuratedSource("global", null, { id: "admin", role: "admin" })).not.toThrow();
  });

  it("non-admin global with no source still rejected", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() => assertCuratedSource("global", null, { id: "u", role: "developer" })).toThrow(
      MCPRegistryError,
    );
  });

  it("user-scope without source rejected even if actor is admin", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() => assertCuratedSource("user", null, { id: "admin", role: "admin" })).toThrow(
      MCPRegistryError,
    );
  });

  it("rejects an unknown source.kind", () => {
    cfgState.booleans.set("MCP_REQUIRE_CATALOG", true);
    expect(() =>
      // @ts-expect-error — invalid kind on purpose.
      assertCuratedSource("project", { kind: "raw" }, { id: "u", role: "developer" }),
    ).toThrow(MCPRegistryError);
  });
});
