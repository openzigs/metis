/**
 * Issue #1868 / #1962 / #1878 — `GOVERNING_DOCS_ENABLED` is ON when unset
 * (#1878: the held-out Sonnet reading of the shipped path passed every
 * threshold). Set, it reads as `ConfigService.getBool(key, true)`
 * (`lib/config/config-service.ts`) reads a boolean: `1`, `true`, `yes`, `on`,
 * case-insensitive and trimmed, keep it on; anything else — `0` included —
 * turns it off.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GOVERNING_DOCS_ENABLED_DEFAULT,
  GOVERNING_DOCS_ENABLED_ENV,
  isGoverningDocsEnabled,
} from "./flag.js";

describe("isGoverningDocsEnabled (#1868, #1962, #1878)", () => {
  const saved = process.env[GOVERNING_DOCS_ENABLED_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[GOVERNING_DOCS_ENABLED_ENV];
    else process.env[GOVERNING_DOCS_ENABLED_ENV] = saved;
  });

  it("names the variable the epic documents", () => {
    expect(GOVERNING_DOCS_ENABLED_ENV).toBe("GOVERNING_DOCS_ENABLED");
  });

  it("is on when the variable is unset (#1878)", () => {
    expect(GOVERNING_DOCS_ENABLED_DEFAULT).toBe(true);
    expect(isGoverningDocsEnabled({})).toBe(true);
  });

  it.each(["1", "true", "TRUE", "True", "yes", "on", "ON", " 1", "true "])(
    "is on for %j",
    (value) => {
      expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: value })).toBe(true);
    },
  );

  it("is on when the variable is set but empty, as ConfigService.getBool(key, true) reads it", () => {
    expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: "" })).toBe(true);
  });

  it.each(["0", " 0 ", "false", "no", "off", "  ", "enabled", "2", "truee", "1 0"])(
    "is off for %j",
    (value) => {
      expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: value })).toBe(false);
    },
  );

  it("reads process.env when no environment is passed, at call time", () => {
    delete process.env[GOVERNING_DOCS_ENABLED_ENV];
    expect(isGoverningDocsEnabled()).toBe(true);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "0";
    expect(isGoverningDocsEnabled()).toBe(false);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "true";
    expect(isGoverningDocsEnabled()).toBe(true);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "enabled";
    expect(isGoverningDocsEnabled()).toBe(false);
  });
});
