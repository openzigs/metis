/**
 * #131 — per-model capability resolution and the tools drop-warning.
 */
import { describe, expect, it, vi } from "vitest";
import {
  NO_PROVIDER_CAPABILITIES,
  createUnsupportedToolsWarner,
  providerSupports,
  resolveCapabilities,
  supportsResponseFormat,
  type ProviderCapabilities,
} from "./capabilities.js";

const STATIC: ProviderCapabilities = { responseFormat: true, nativeToolCalls: true };
const PER_MODEL = (model: string): ProviderCapabilities =>
  model === "laguna-s-2.1"
    ? { responseFormat: true, nativeToolCalls: false, jsonSchema: false, jsonObject: true }
    : STATIC;

describe("resolveCapabilities", () => {
  it("prefers the per-model answer when a model is named", () => {
    const p = { capabilities: STATIC, capabilitiesFor: PER_MODEL };
    expect(resolveCapabilities(p, "laguna-s-2.1").nativeToolCalls).toBe(false);
    expect(resolveCapabilities(p, "gemma3:12b").nativeToolCalls).toBe(true);
    expect(resolveCapabilities(p).nativeToolCalls).toBe(true);
  });

  it("falls back to the static record when the per-model lookup throws, then to nothing", () => {
    const throwing = {
      capabilities: STATIC,
      capabilitiesFor: () => {
        throw new Error("catalog down");
      },
    };
    expect(resolveCapabilities(throwing, "m")).toBe(STATIC);
    expect(resolveCapabilities({}, "m")).toBe(NO_PROVIDER_CAPABILITIES);
    expect(resolveCapabilities(null)).toBe(NO_PROVIDER_CAPABILITIES);
  });

  it("providerSupports honours the model argument", () => {
    const p = { capabilities: STATIC, capabilitiesFor: PER_MODEL };
    expect(providerSupports(p, "nativeToolCalls", "laguna-s-2.1")).toBe(false);
    expect(providerSupports(p, "nativeToolCalls")).toBe(true);
  });
});

describe("supportsResponseFormat by mode", () => {
  const p = { capabilities: STATIC, capabilitiesFor: PER_MODEL };

  it("answers json_schema and json_object separately for a model that differs", () => {
    expect(supportsResponseFormat(p, "laguna-s-2.1", "json_schema")).toBe(false);
    expect(supportsResponseFormat(p, "laguna-s-2.1", "json_object")).toBe(true);
    expect(supportsResponseFormat(p, "laguna-s-2.1")).toBe(true);
  });

  it("reads an absent mode flag as the pre-#131 responseFormat answer", () => {
    expect(supportsResponseFormat({ capabilities: STATIC }, undefined, "json_schema")).toBe(true);
    expect(supportsResponseFormat({ capabilities: STATIC }, undefined, "json_object")).toBe(true);
    expect(
      supportsResponseFormat({ capabilities: NO_PROVIDER_CAPABILITIES }, "m", "json_object"),
    ).toBe(false);
  });
});

describe("createUnsupportedToolsWarner", () => {
  it("warns once per model, never for no tools, and never logs tool content", () => {
    const warn = vi.fn();
    const drop = createUnsupportedToolsWarner({ warn }, "local-gemma");
    drop("a", undefined);
    drop("a", []);
    drop("a", [{ name: "secret_tool" }]);
    drop("a", [{ name: "secret_tool" }]);
    drop("b", [{ name: "x" }, { name: "y" }]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toEqual({
      provider: "local-gemma",
      model: "b",
      toolCount: 2,
      capability: "nativeToolCalls",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret_tool");
  });
});
