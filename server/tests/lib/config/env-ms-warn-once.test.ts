/**
 * `parseStrictMs` `warnOnce` — a setting read on every request warns once per
 * (setting, raw value), not on every read; without the option every ignored
 * value still warns (review of #284).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../../src/lib/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/lib/logger.js")>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      return name === "config.env-ms" ? { ...real, warn: logWarn } : real;
    },
  };
});

import { parseStrictMs, resetEnvMsWarningsForTests } from "../../../src/lib/config/env-ms.js";

beforeEach(() => {
  logWarn.mockReset();
  resetEnvMsWarningsForTests();
});

describe("parseStrictMs warnOnce", () => {
  it("without warnOnce, every ignored read warns", () => {
    parseStrictMs("X_MS", "abc", 5);
    parseStrictMs("X_MS", "abc", 5);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("with warnOnce, a repeated (setting, value) warns once and still keeps the default", () => {
    expect(parseStrictMs("X_MS", "abc", 5, { warnOnce: true })).toBe(5);
    expect(parseStrictMs("X_MS", "abc", 5, { warnOnce: true })).toBe(5);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("a valid value is never recorded and never warns", () => {
    expect(parseStrictMs("X_MS", "1000", 5, { warnOnce: true })).toBe(1000);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("the remembered set is bounded: past its cap it is cleared, so an old value warns again", () => {
    parseStrictMs("X_MS", "first", 5, { warnOnce: true });
    for (let i = 0; i < 256; i++) parseStrictMs("X_MS", `bad-${i}`, 5, { warnOnce: true });
    expect(logWarn).toHaveBeenCalledTimes(257);
    parseStrictMs("X_MS", "first", 5, { warnOnce: true });
    expect(logWarn).toHaveBeenCalledTimes(258);
  });
});
