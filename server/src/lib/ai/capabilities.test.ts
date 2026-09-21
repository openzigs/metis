/**
 * Tests for the provider capability seam (#1115).
 *
 * The seam exists so callers can ask a provider what it actually honours
 * instead of passing an option that a non-supporting adapter silently drops.
 * These tests pin the two contracts #1114 depends on:
 *   1. `providerSupports` / `supportsResponseFormat` read as `false` for a
 *      provider that declares nothing — absence means "degrade", never
 *      "assume supported".
 *   2. `createUnsupportedResponseFormatWarner` warns at most ONCE per provider
 *      instance, and only when a caller actually supplied a schema.
 */
import { describe, expect, it, vi } from "vitest";
import {
  NO_PROVIDER_CAPABILITIES,
  createUnsupportedResponseFormatWarner,
  providerSupports,
  supportsResponseFormat,
  type ProviderCapabilities,
} from "./capabilities.js";

const FULL: ProviderCapabilities = { responseFormat: true, nativeToolCalls: true };

describe("NO_PROVIDER_CAPABILITIES", () => {
  it("declares every capability false", () => {
    expect(NO_PROVIDER_CAPABILITIES).toEqual({ responseFormat: false, nativeToolCalls: false });
  });

  it("is frozen so a shared adapter default cannot be mutated at runtime", () => {
    expect(Object.isFrozen(NO_PROVIDER_CAPABILITIES)).toBe(true);
  });
});

describe("providerSupports", () => {
  it("returns true only for a capability the provider declares true", () => {
    expect(providerSupports({ capabilities: FULL }, "responseFormat")).toBe(true);
    expect(providerSupports({ capabilities: FULL }, "nativeToolCalls")).toBe(true);
  });

  it("returns false for a capability the provider declares false", () => {
    expect(
      providerSupports(
        { capabilities: { responseFormat: false, nativeToolCalls: true } },
        "responseFormat",
      ),
    ).toBe(false);
  });

  it("returns false when the provider declares no capabilities at all", () => {
    expect(providerSupports({}, "responseFormat")).toBe(false);
    expect(providerSupports({ capabilities: undefined }, "nativeToolCalls")).toBe(false);
  });

  it("returns false for a null/undefined provider rather than throwing", () => {
    expect(providerSupports(null, "responseFormat")).toBe(false);
    expect(providerSupports(undefined, "responseFormat")).toBe(false);
  });
});

describe("supportsResponseFormat", () => {
  it("is sugar for providerSupports(provider, 'responseFormat')", () => {
    expect(supportsResponseFormat({ capabilities: FULL })).toBe(true);
    expect(supportsResponseFormat({ capabilities: NO_PROVIDER_CAPABILITIES })).toBe(false);
    expect(supportsResponseFormat(undefined)).toBe(false);
  });
});

describe("createUnsupportedResponseFormatWarner", () => {
  it("does not warn when the caller supplies no schema", () => {
    const warn = vi.fn();
    const notify = createUnsupportedResponseFormatWarner({ warn }, "anthropic");

    notify(undefined);
    notify(null);

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns exactly once no matter how many calls supply a schema", () => {
    const warn = vi.fn();
    const notify = createUnsupportedResponseFormatWarner({ warn }, "anthropic");

    notify({ type: "json_schema" });
    notify({ type: "json_schema" });
    notify({ type: "json_schema" });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("names the provider and the ignored option so the drop is diagnosable", () => {
    const warn = vi.fn();
    createUnsupportedResponseFormatWarner({ warn }, "copilot-native")({ type: "json_schema" });

    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("responseFormat");
    expect(meta).toMatchObject({ provider: "copilot-native", capability: "responseFormat" });
  });

  it("never echoes the caller's schema payload into the log", () => {
    const warn = vi.fn();
    const notify = createUnsupportedResponseFormatWarner({ warn }, "anthropic");

    notify({ type: "json_schema", json_schema: { name: "secret_schema_name" } });

    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret_schema_name");
  });

  it("keeps warn state per warner, so two provider instances each warn once", () => {
    const warn = vi.fn();
    const a = createUnsupportedResponseFormatWarner({ warn }, "anthropic");
    const b = createUnsupportedResponseFormatWarner({ warn }, "anthropic");

    a({ type: "json_schema" });
    b({ type: "json_schema" });

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
