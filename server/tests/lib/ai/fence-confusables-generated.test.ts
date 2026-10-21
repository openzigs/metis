/**
 * #1114 / #1350 review finding 5 — the confusables table behind the fence scrub
 * must be reproducible from its committed source, with no network in the test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODULE_PATH,
  SOURCE_URL,
  SUBSET_PATH,
  extractSubset,
  parseSubset,
  renderModule,
} from "../../../scripts/generate-fence-confusables.js";
import { CONFUSABLE_SOURCES } from "../../../src/lib/ai/tool-runtime/fence-confusables.generated.js";

const subset = readFileSync(SUBSET_PATH, "utf8");

describe("fence confusables table", () => {
  it("the committed module is exactly what the generator renders from the committed subset", () => {
    expect(readFileSync(MODULE_PATH, "utf8")).toBe(renderModule(subset));
  });

  it("the imported table equals the parsed subset", () => {
    expect(CONFUSABLE_SOURCES).toEqual(parseSubset(subset));
  });

  it("the subset records its source URL, version and the SHA-256 of the full file", () => {
    expect(subset).toContain(`# Source: ${SOURCE_URL}`);
    expect(subset).toMatch(/^# Version: \d+\.\d+\.\d+$/m);
    expect(subset).toMatch(/^# SHA-256 of the full file: [0-9a-f]{64}$/m);
  });

  it("the subset is pure ASCII (no glyphs from the source comments)", () => {
    expect([...subset].every((ch) => (ch.codePointAt(0) as number) < 0x80)).toBe(true);
  });

  it("extractSubset keeps only single-code-point rows whose prototype is a fence character", () => {
    const full = [
      "# Date: 2099-01-01, 00:00:00 GMT",
      "# Version: 99.0.0",
      "041C ;\t004D ;\tMA\t# ( М → M ) CYRILLIC CAPITAL LETTER EM",
      "0430 ;\t0061 ;\tMA\t# ( а → a )",
      "FF1D ;\t003D ;\tMA\t# ( ＝ → = )",
      "0031 ;\t006C ;\tMA\t# ( 1 → l )",
      "0417 ;\t0033 ;\tMA\t# ( З → 3 ) not a fence character",
      "2474 ;\t0028 0031 0029 ;\tMA\t# multi-unit prototype",
      "",
    ].join("\n");
    const out = extractSubset(full);
    expect(out).toContain("# Version: 99.0.0");
    expect(out.split("\n").filter((l) => /^[0-9A-F]/.test(l))).toEqual([
      "041C ; 004D ; MA",
      "0430 ; 0061 ; MA",
      "FF1D ; 003D ; MA",
      "0031 ; 006C ; MA",
    ]);
    expect(parseSubset(out)).toEqual([
      ["=", [0xff1d]],
      ["A", [0x0430]],
      ["I", [0x0031]],
      ["M", [0x041c]],
    ]);
  });

  it("parseSubset rejects a malformed row", () => {
    expect(() => parseSubset("041C 004D MA\n")).toThrow(/unparsable/);
  });
});
