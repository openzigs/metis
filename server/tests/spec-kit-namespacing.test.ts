/**
 * Epic #396 (MVP-1) — namespacing tests.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeSpecKitCommand,
  isSpecKitNamespacedCommand,
  parseSpecKitCommand,
  SPECKIT_COMMANDS,
  SPECKIT_LEGACY_ALIAS,
} from "@metis/shared";

describe("MVP-1 namespacing", () => {
  it("recognizes every speckit.* canonical command", () => {
    for (const cmd of SPECKIT_COMMANDS) {
      expect(isSpecKitNamespacedCommand(cmd)).toBe(true);
    }
  });

  it("normalizes uppercase and slashed forms", () => {
    expect(normalizeSpecKitCommand("SpecKit.Specify")).toEqual({
      canonical: "speckit.specify",
      legacy: false,
    });
    expect(normalizeSpecKitCommand("/speckit.plan")).toEqual({
      canonical: "speckit.plan",
      legacy: false,
    });
  });

  it("maps legacy short names to their canonical form with legacy=true", () => {
    expect(normalizeSpecKitCommand("specify")).toEqual({
      canonical: "speckit.specify",
      legacy: true,
    });
    expect(normalizeSpecKitCommand("/plan")).toEqual({
      canonical: "speckit.plan",
      legacy: true,
    });
  });

  it("returns null for unknown commands", () => {
    expect(normalizeSpecKitCommand("speckit.nonsense")).toBeNull();
    expect(normalizeSpecKitCommand("foo")).toBeNull();
  });

  it("legacy alias map is well-formed", () => {
    for (const cmd of SPECKIT_COMMANDS) {
      expect(SPECKIT_LEGACY_ALIAS).toHaveProperty(cmd);
    }
  });

  it("parseSpecKitCommand accepts namespaced form for v1.2 commands", () => {
    expect(parseSpecKitCommand("/speckit.specify Build login")).toEqual({
      command: "specify",
      input: "Build login",
    });
    expect(parseSpecKitCommand("/SPECKIT.PLAN")).toEqual({
      command: "plan",
      input: "",
    });
  });

  it("parseSpecKitCommand returns null for namespaced commands without a v1.2 alias", () => {
    // /speckit.constitution has no legacy alias yet — resolved by route layer instead
    expect(parseSpecKitCommand("/speckit.constitution …")).toBeNull();
    expect(parseSpecKitCommand("/speckit.checklist")).toBeNull();
  });

  it("parseSpecKitCommand still accepts legacy short form", () => {
    expect(parseSpecKitCommand("/specify hi")).toEqual({ command: "specify", input: "hi" });
  });

  it("parseSpecKitCommand returns null for non-spec-kit input", () => {
    expect(parseSpecKitCommand("/help")).toBeNull();
    expect(parseSpecKitCommand("just chat")).toBeNull();
    expect(parseSpecKitCommand(123 as unknown as string)).toBeNull();
  });
});
