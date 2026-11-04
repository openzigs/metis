/**
 * #1578 — what a hex-encoding call returns reaches the model that writes the
 * module facts (Phase 1) and the consistency check, and a formula without one
 * is listed exactly as before.
 */
import { describe, expect, it } from "vitest";
import { extractFormulas } from "../code-graph/formula-extractor.js";
import {
  buildPhase1UserMessage,
  encodedLengthFacts,
  type ModuleFacts,
} from "./holistic-synthesizer.js";

const SOURCE = [
  "MaxTokenAge = 30",
  "func (s *Storage) CreateAPIKey() {",
  "\ttoken := crypto.GenerateRandomStringHex(32)",
  "}",
].join("\n");

const formulas = extractFormulas(SOURCE, "internal/storage/api_key.go", "go");

describe("the Phase 1 prompt's extracted formulas", () => {
  it("says what a hex-encoding call returns, and lists every other formula as before", () => {
    const prompt = buildPhase1UserMessage({
      moduleName: "storage",
      classCount: 1,
      topClasses: ["Storage"],
      methodCount: 1,
      part: null,
      code: SOURCE,
      formulas,
      rules: [],
      sasSteps: [],
      dataLineage: null,
      rationale: [],
    });
    const listed = prompt.split("\n").filter((line) => line.startsWith("- constant:"));
    expect(listed).toEqual([
      "- constant: 30",
      "- constant: GenerateRandomStringHex(32) (32 bytes, hex-encoded as 64 characters)",
    ]);
  });
});

describe("encodedLengthFacts", () => {
  it("collects every hex-encoding call of the modules with its source line", () => {
    const facts = [
      { modulePath: "internal/storage", formulas } as unknown as ModuleFacts,
      { modulePath: "internal/model", formulas: [] } as unknown as ModuleFacts,
    ];
    expect(encodedLengthFacts(facts)).toEqual([
      {
        bytes: 32,
        characters: 64,
        expression: "GenerateRandomStringHex(32)",
        source: "internal/storage/api_key.go:3",
      },
    ]);
    expect(encodedLengthFacts([])).toEqual([]);
  });
});
