/**
 * Issue #1868 / #1962 — `GOVERNING_DOCS_ENABLED` accepts the truthy spellings
 * METIS's other boolean settings accept: `ConfigService.getBool`
 * (`lib/config/config-service.ts`) reads `1`, `true`, `yes`, `on`,
 * case-insensitive and trimmed. Anything else — an unrecognised value
 * included — leaves the feature off.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GOVERNING_DOCS_ENABLED_ENV, isGoverningDocsEnabled } from "./flag.js";

describe("isGoverningDocsEnabled (#1868, #1962)", () => {
  const saved = process.env[GOVERNING_DOCS_ENABLED_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[GOVERNING_DOCS_ENABLED_ENV];
    else process.env[GOVERNING_DOCS_ENABLED_ENV] = saved;
  });

  it("names the variable the epic documents", () => {
    expect(GOVERNING_DOCS_ENABLED_ENV).toBe("GOVERNING_DOCS_ENABLED");
  });

  it("is off when the variable is unset", () => {
    expect(isGoverningDocsEnabled({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", "True", "yes", "on", "ON", " 1", "true "])(
    "is on for %j",
    (value) => {
      expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: value })).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", "", "  ", "enabled", "2", "truee", "1 0"])(
    "is off for %j",
    (value) => {
      expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: value })).toBe(false);
    },
  );

  it("reads process.env when no environment is passed, at call time", () => {
    delete process.env[GOVERNING_DOCS_ENABLED_ENV];
    expect(isGoverningDocsEnabled()).toBe(false);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "true";
    expect(isGoverningDocsEnabled()).toBe(true);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "enabled";
    expect(isGoverningDocsEnabled()).toBe(false);
  });
});
