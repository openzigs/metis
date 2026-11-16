/**
 * #2587 review — the kill switch fails closed: a value that is set but is not
 * a mode (a typo, `off`, `false`, `0`) runs the cheaper `fast` pass and warns
 * once, while unset or empty is the `explore` default.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

const { __resetConfigSingleton } = await import("../config/config-service.js");
const { CODE_EXPLORATION_KEY, DEFAULT_CODE_PASS_MODE, readCodeExplorationSetting } =
  await import("./code-exploration-setting.js");
const { getKeyDef } = await import("../config/key-registry.js");

function withValue(value: string | undefined): void {
  if (value === undefined) delete process.env.ANALYSIS_CODE_EXPLORATION;
  else process.env.ANALYSIS_CODE_EXPLORATION = value;
  __resetConfigSingleton();
}

afterEach(() => {
  withValue(undefined);
  warn.mockClear();
});

describe("readCodeExplorationSetting", () => {
  it("#2295 — the registry declares the default the reader applies", () => {
    expect(getKeyDef(CODE_EXPLORATION_KEY)?.default).toBe(DEFAULT_CODE_PASS_MODE);
  });

  it("unset and empty are the explore default, with no warning", () => {
    withValue(undefined);
    expect(readCodeExplorationSetting()).toBe("explore");
    withValue("  ");
    expect(readCodeExplorationSetting()).toBe("explore");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["off", "false", "0", "fsat", "deep"])("a set but unknown value %j is fast", (v) => {
    withValue(v);
    expect(readCodeExplorationSetting()).toBe("fast");
  });

  it("warns once for a repeated unknown value, naming the key and never the value", () => {
    withValue("Disabled-Value");
    readCodeExplorationSetting();
    readCodeExplorationSetting();
    readCodeExplorationSetting();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toEqual({ key: CODE_EXPLORATION_KEY });
    expect(message).toMatch(/runs fast/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/disabled-value/i);
  });

  it("a recognised value never warns", () => {
    withValue("explore");
    expect(readCodeExplorationSetting()).toBe("explore");
    withValue("FAST");
    expect(readCodeExplorationSetting()).toBe("fast");
    expect(warn).not.toHaveBeenCalled();
  });
});
