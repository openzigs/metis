/** #1327 — the per-model length overrun a planned batch's words are corrected by. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeyDef } from "../config/key-registry.js";
import {
  LENGTH_OVERRUN_KEY,
  MAX_LENGTH_OVERRUN,
  MIN_LENGTH_OVERRUN,
  parseLengthOverrun,
  resolveLengthOverrun,
} from "./length-calibration.js";

afterEach(() => vi.unstubAllEnvs());

describe("parseLengthOverrun", () => {
  it("reads pattern=factor pairs, lower-cased, and ignores blanks", () => {
    expect(parseLengthOverrun(" DeepSeek=1.4 , haiku = 1.1 ,, *=1 ")).toEqual({
      rules: [
        { pattern: "deepseek", factor: 1.4 },
        { pattern: "haiku", factor: 1.1 },
        { pattern: "*", factor: 1 },
      ],
      unrecognised: [],
    });
    expect(parseLengthOverrun(undefined)).toEqual({ rules: [], unrecognised: [] });
    expect(parseLengthOverrun("")).toEqual({ rules: [], unrecognised: [] });
  });

  it("returns entries it cannot read, and keeps the rest", () => {
    expect(parseLengthOverrun("deepseek, =1.2, haiku=fast, x=0, y=-1, sonnet=1.2")).toEqual({
      rules: [{ pattern: "sonnet", factor: 1.2 }],
      unrecognised: ["deepseek", "=1.2", "haiku=fast", "x=0", "y=-1"],
    });
  });

  it("clamps a factor to the honoured range", () => {
    expect(parseLengthOverrun("a=9,b=0.1").rules.map((r) => r.factor)).toEqual([
      MAX_LENGTH_OVERRUN,
      MIN_LENGTH_OVERRUN,
    ]);
  });
});

describe("resolveLengthOverrun", () => {
  it("gives DeepSeek its measured overrun and every other model 1 by default", () => {
    expect(resolveLengthOverrun("deepseek-flash")).toBe(1.5);
    expect(resolveLengthOverrun("DeepSeek-Chat")).toBe(1.5);
    expect(resolveLengthOverrun("claude-haiku-5-5")).toBe(1);
    expect(resolveLengthOverrun("gpt-5")).toBe(1);
    expect(resolveLengthOverrun(undefined)).toBe(1);
    expect(resolveLengthOverrun("")).toBe(1);
  });

  it("lets the setting override the default and add models, first match winning", () => {
    vi.stubEnv(LENGTH_OVERRUN_KEY, "deepseek=1.3, haiku=1.1, claude=1.05");
    expect(resolveLengthOverrun("deepseek-flash")).toBe(1.3);
    expect(resolveLengthOverrun("claude-haiku-5-5")).toBe(1.1);
    expect(resolveLengthOverrun("claude-sonnet-5")).toBe(1.05);
    expect(resolveLengthOverrun("gpt-5")).toBe(1);
  });

  it("applies a configured * to every model the configured rules before it missed", () => {
    vi.stubEnv(LENGTH_OVERRUN_KEY, "haiku=1.1, *=1.2");
    expect(resolveLengthOverrun("claude-haiku-5-5")).toBe(1.1);
    expect(resolveLengthOverrun("deepseek-flash")).toBe(1.2);
    expect(resolveLengthOverrun(undefined)).toBe(1.2);
  });

  it("falls back to the defaults when the setting reads as nothing", () => {
    vi.stubEnv(LENGTH_OVERRUN_KEY, "nonsense");
    expect(resolveLengthOverrun("deepseek-flash")).toBe(1.5);
  });
});

describe("the DOCS_GEN_LENGTH_OVERRUN registry entry", () => {
  it("accepts what the parser reads and rejects what it would ignore", () => {
    const schema = getKeyDef(LENGTH_OVERRUN_KEY)!.schema;
    for (const ok of [
      "deepseek=1.5",
      " deepseek = 1.4 , haiku=1.1 ",
      "*=1",
      "claude-haiku-5=1.08",
    ]) {
      expect(schema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["", "deepseek", "deepseek=fast", "=1.2", "a=1,", "a=1,,b=2"]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });
});
