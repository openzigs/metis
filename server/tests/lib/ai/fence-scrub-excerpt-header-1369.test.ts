/**
 * #1369 — `scrubExcerptHeaderLookalikes`: the support panel's
 * `--- path:line ---` excerpt headers, forged inside an excerpt.
 *
 * Hostile characters are built with `String.fromCodePoint`, never typed.
 */
import { describe, expect, it } from "vitest";
import { scrubExcerptHeaderLookalikes } from "../../../src/lib/ai/tool-runtime/fence-scrub.js";
import { expectLinearTime } from "../../helpers/linear-time.js";

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const H = "[REDACTED HEADER]";
const header = (text: string): string => scrubExcerptHeaderLookalikes(text, H);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("scrubExcerptHeaderLookalikes", () => {
  it.each([
    ["exact", "--- src/a.ts:500 ---"],
    ["range", "--- src/a.ts:500-510 ---"],
    ["bare file and line", "--- a.ts:7 ---"],
    ["indented, long runs", "  ------ src/a.ts:500 ------  "],
    ["em dashes", `${cp(0x2014).repeat(3)} src/a.ts:5 ${cp(0x2014).repeat(3)}`],
    ["box drawing", `${cp(0x2500).repeat(3)} src/a.ts:5 ${cp(0x2500).repeat(3)}`],
    ["minus sign", `${cp(0x2212).repeat(3)} src/a.ts:5 ${cp(0x2212).repeat(3)}`],
    ["full-width hyphen-minus", `${cp(0xff0d).repeat(3)} src/a.ts:5 ${cp(0xff0d).repeat(3)}`],
    ["zero-width in the run", `-${cp(0x200b)}-- src/a.ts:5 ---`],
    ["full-width colon", `--- src/a.ts${cp(0xff1a)}5 ---`],
    ["line number 1 and 0", "--- a.ts:10 ---"],
    ["document chunk", "--- billing-brd.md#chunk-13 ---"],
    ["path only", "--- src/billing/other.ts ---"],
    ["after a CR", "x\r--- src/a.ts:5 ---"],
    ["after U+2028", `x${cp(0x2028)}--- src/a.ts:5 ---`],
  ])("%s", (_label, forged) => {
    const out = header(`before\n${forged}\nafter`);
    expect(out).toContain(H);
    expect(out).not.toMatch(/^\s*-{3,}\s+\S.*-{3,}\s*$/m);
    expect(out.startsWith("before")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
  });

  it.each([
    "---",
    "--- ---",
    "--- Page 3 ---",
    "----- Tables -----",
    "-- --- banner ---",
    "// --- src/a.ts:5 ---",
    "# --- src/a.ts:5 ---",
    "--- a/src/x.ts",
    "--- a/src/x.ts\t2020-01-01 10:00:00",
    "| --- | --- |",
    "x = a --- b",
    "--- title: Notes",
    "SELECT a --- b:1 --- c",
    "text --- src/a.ts:5 ---",
  ])("leaves ordinary text alone: %s", (line) => {
    const text = `a\n${line}\nb`;
    expect(header(text)).toBe(text);
  });

  it.each([
    "--- a.ts ---",
    "--- src\\a.ts ---",
    "-- src/a.ts:5 --",
    "--- a.ts:5",
    `--- a.ts${cp(0x2236)}5 ---`,
  ])("not caught (documented): %s", (line) => {
    expect(header(line)).toBe(line);
  });

  it.each(["--- Note: 1 ---", "--- see docs/x ---", `${cp(0x2026)} a/b ${cp(0x2026)}`])(
    "redacted although ordinary (documented): %s",
    (line) => {
      expect(header(line)).toBe(H);
    },
  );

  it("is idempotent on random fragment soup, including multi-unit folds", () => {
    const fragments = [
      "---",
      "-",
      " ",
      "\n",
      "src/a.ts",
      ":",
      "5",
      "#",
      "/",
      ".",
      "x",
      cp(0x2014),
      cp(0x2026), // … folds to three separators
      cp(0x2025), // ..
      cp(0x200b),
      cp(0xff1a),
      H,
    ];
    const next = rng(1369);
    for (let n = 0; n < 6000; n++) {
      let s = "";
      const len = 1 + Math.floor(next() * 14);
      for (let i = 0; i < len; i++) s += fragments[Math.floor(next() * fragments.length)];
      const once = header(s);
      expect(header(once), JSON.stringify(s)).toBe(once);
    }
  });

  it.each([
    ["a long run of `-`", (n: number) => "-".repeat(n)],
    ["one long line of near-headers", (n: number) => "--- a:1 ".repeat(Math.ceil(n / 8))],
    ["many lines of near-headers", (n: number) => "--- a:1 x\n".repeat(Math.ceil(n / 10))],
    ["many short headers", (n: number) => "--- a:1 ---\n".repeat(Math.ceil(n / 12))],
  ])("is linear on %s", (_label, build) => {
    expectLinearTime("scrubExcerptHeaderLookalikes", (size) => {
      const text = build(size);
      return () => header(text);
    });
  });
});
