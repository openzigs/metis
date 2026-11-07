/**
 * Issue #1868 — `GOVERNING_DOCS_ENABLED` is read the way `SEMANTIC_CACHE_ENABLED`
 * is (`lib/ai/semantic-cache.ts`): exactly `"1"` turns it on, anything else —
 * including `"true"` — leaves it off.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GOVERNING_DOCS_ENABLED_ENV, isGoverningDocsEnabled } from "./flag.js";

describe("isGoverningDocsEnabled (#1868)", () => {
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

  it.each(["0", "true", "", " 1", "1 ", "yes", "on", "TRUE"])("is off for %j", (value) => {
    expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: value })).toBe(false);
  });

  it('is on only for "1"', () => {
    expect(isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: "1" })).toBe(true);
  });

  it("reads process.env when no environment is passed, at call time", () => {
    delete process.env[GOVERNING_DOCS_ENABLED_ENV];
    expect(isGoverningDocsEnabled()).toBe(false);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "1";
    expect(isGoverningDocsEnabled()).toBe(true);
    process.env[GOVERNING_DOCS_ENABLED_ENV] = "true";
    expect(isGoverningDocsEnabled()).toBe(false);
  });
});
