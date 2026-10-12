/**
 * #1070 — the canonical facts sheet: named values read from the source, kept
 * when more than one part of the document would state them, given to the
 * sections that mention them and citable like any other source.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedFormula } from "../code-graph/formula-extractor.js";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  CANONICAL_SOURCE_PREFIX,
  FACT_SHEET_MAX,
  FACT_SHEET_MAX_PER_CALL,
  FACT_VALUE_MAX_CHARS,
  buildFactSheet,
  canonicalFactSource,
  canonicalSourceId,
  classifyFactValue,
  factSheetFingerprint,
  factsMentionedIn,
  identifiersOf,
  isDistinctiveName,
  renderCanonicalFactsBlock,
  withCanonicalSources,
  type CanonicalFact,
  type FactSheetModule,
} from "./canonical-facts.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import { readableSourceReference, renderCitationFootnotes } from "./citation-footnotes.js";

const formula = (over: Partial<ExtractedFormula>): ExtractedFormula => ({
  kind: "arithmetic",
  expression: "a * 2",
  description: "",
  name: "value",
  resolvedValue: null,
  filePath: "internal/model/feed.go",
  startLine: 1,
  endLine: 1,
  symbolContext: null,
  ...over,
});

const constant = (name: string, value: string, line = 10): PersistedMinedRule => ({
  language: "go",
  kind: "const",
  expression: `const ${name} = ${value}`,
  summary: `Constant \`${name}\` = ${value}`,
  file: "internal/model/entry.go",
  line,
  context: null,
});

const mod = (
  name: string,
  facts: string,
  over: Partial<FactSheetModule> = {},
): FactSheetModule => ({
  modulePath: `internal/${name}`,
  moduleName: name,
  facts,
  formulas: [],
  ...over,
});

/** The Miniflux scheduler interval, as the Go formula extractor stored it in run 7. */
const INTERVAL = formula({
  expression:
    "(7 * 24 * time.Hour) / time.Duration(weeklyCount*config.Opts.SchedulerEntryFrequencyFactor())",
  name: "interval",
  startLine: 131,
  symbolContext: "internal/model/feed.go::ScheduleNextCheck",
});

const schedulerProject = (): FactSheetModule[] => [
  mod(
    "model",
    [
      "PURPOSE",
      "Feed model.",
      "RULES",
      "- `MaxEntryLimit` caps a page; `ScheduleNextCheck` uses `weeklyCount`.",
      "FORMULAS",
      "- `ScheduleNextCheck` computes the interval from `weeklyCount`.",
    ].join("\n"),
    { formulas: [INTERVAL], minedRules: [constant("MaxEntryLimit", "1000", 20)] },
  ),
  mod(
    "api",
    [
      "PURPOSE",
      "API.",
      "RULES",
      "- A request for more than `MaxEntryLimit` entries is refused.",
    ].join("\n"),
  ),
];

describe("what counts as a fact", () => {
  it("takes numbers, scaled numbers and enumeration values from constants", () => {
    expect(classifyFactValue("1000", "constant")).toBe("constant");
    expect(classifyFactValue("-0.25", "constant")).toBe("constant");
    expect(classifyFactValue("20 * time.Second", "constant")).toBe("constant");
    expect(classifyFactValue("4096 * 4096", "arithmetic")).toBe("constant");
    expect(classifyFactValue("1 << 20", "constant")).toBe("constant");
    expect(classifyFactValue('"entry_frequency"', "constant")).toBe("enumeration");
    expect(classifyFactValue("'desc'", "constant")).toBe("enumeration");
  });

  it("takes a computation, not a path, a message, a query or an allocation", () => {
    expect(classifyFactValue("(7 * 24 * time.Hour) / time.Duration(n*factor)", "arithmetic")).toBe(
      "formula",
    );
    expect(classifyFactValue("offset + nbItemsPerPage", "arithmetic")).toBe("formula");
    expect(classifyFactValue("max(10, topCandidate.score/5)", "arithmetic")).toBe("formula");
    expect(classifyFactValue('strings.TrimSuffix(endpoint, "/")', "arithmetic")).toBeNull();
    expect(classifyFactValue('"https://api.example.com/" + id', "arithmetic")).toBeNull();
    expect(classifyFactValue("`SELECT count(*) FROM feeds`", "arithmetic")).toBeNull();
    expect(classifyFactValue("make([]*optionPair, 0, len(sortedKeys))", "arithmetic")).toBeNull();
    expect(classifyFactValue("append(attrs, a+b)", "arithmetic")).toBeNull();
    expect(classifyFactValue("r.Header.Get(name)", "arithmetic")).toBeNull();
  });

  it("does not read a trailing comment as part of the value", () => {
    // `in-between` in the comment is not a subtraction.
    expect(
      classifyFactValue("true // To insert spaces in-between words.", "arithmetic"),
    ).toBeNull();
    expect(classifyFactValue("1024 // bytes", "constant")).toBe("constant");
    expect(classifyFactValue("width * height # pixels", "arithmetic")).toBe("formula");
  });

  it("refuses an empty value, a call, an interpolated string and an over-long one", () => {
    expect(classifyFactValue("  ", "constant")).toBeNull();
    expect(classifyFactValue("errors.New(x)", "constant")).toBeNull();
    expect(classifyFactValue('"${a}-${b}"', "constant")).toBeNull();
    expect(classifyFactValue('""', "constant")).toBeNull();
    expect(classifyFactValue(`1 + ${"x + ".repeat(200)}1`, "arithmetic")).toBeNull();
  });

  it("knows a compound name from a word a dozen functions use", () => {
    for (const name of ["weeklyCount", "MaxEntryLimit", "MAX_ENTRIES", "defaultHTTPTimeout"]) {
      expect(isDistinctiveName(name)).toBe(true);
    }
    for (const name of ["interval", "total", "err", "Version", "TOP", "a_b"]) {
      expect(isDistinctiveName(name)).toBe(false);
    }
  });
});

describe("buildFactSheet", () => {
  it("puts on the sheet the facts mentioned in two places, with their source line and owner", () => {
    const sheet = buildFactSheet(schedulerProject());
    // Both are mentioned twice; a formula is listed before a constant.
    expect(sheet.facts.map((f) => [f.name, f.kind, f.value, `${f.file}:${f.line}`])).toEqual([
      [
        "ScheduleNextCheck.interval",
        "formula",
        "(7 * 24 * time.Hour) / time.Duration(weeklyCount*config.Opts.SchedulerEntryFrequencyFactor())",
        "internal/model/feed.go:131",
      ],
      ["MaxEntryLimit", "constant", "1000", "internal/model/entry.go:20"],
    ]);
    const [interval, limit] = sheet.facts;
    expect(limit.ownerSectionId).toBe("rules");
    expect(interval.ownerSectionId).toBe("formulas");
    // A formula in a function is found by the function's name; `interval` alone is not a term.
    expect(interval.terms).toEqual(["ScheduleNextCheck"]);
    expect(limit.mentions).toBe(2);
    expect(sheet).toEqual(expect.objectContaining({ candidates: 2, notShared: 0, overCap: 0 }));
  });

  it("owns an enumeration value in the data model", () => {
    const sheet = buildFactSheet([
      mod(
        "model",
        "RULES\n- `SchedulerRoundRobin` is the default.\nENTITIES\n- `SchedulerRoundRobin`",
        {
          minedRules: [constant("SchedulerRoundRobin", '"round_robin"')],
        },
      ),
    ]);
    expect(sheet.facts[0]).toEqual(
      expect.objectContaining({ kind: "enumeration", ownerSectionId: "data-model" }),
    );
  });

  it("leaves off a fact only one place mentions: no section would restate it", () => {
    const sheet = buildFactSheet([
      mod("model", "RULES\n- `MaxEntryLimit` caps a page.", {
        minedRules: [constant("MaxEntryLimit", "1000")],
      }),
    ]);
    expect(sheet.facts).toEqual([]);
    expect(sheet.notShared).toBe(1);
  });

  it("leaves off a name the source gives two values, and counts it", () => {
    const sheet = buildFactSheet([
      mod("a", "RULES\n- `PageLimit`\nFORMULAS\n- `PageLimit`", {
        minedRules: [constant("PageLimit", "50", 1)],
      }),
      mod("b", "RULES\n- `PageLimit`", { minedRules: [constant("PageLimit", "100", 2)] }),
    ]);
    expect(sheet.facts).toEqual([]);
    expect(sheet.ambiguous).toBe(2);
  });

  it("counts a line two extractors read once", () => {
    const sheet = buildFactSheet([
      mod("model", "RULES\n- `MaxEntryLimit`\nFORMULAS\n- `MaxEntryLimit`", {
        minedRules: [constant("MaxEntryLimit", "1000", 20)],
        formulas: [
          formula({
            kind: "constant",
            name: "MaxEntryLimit",
            expression: "1000",
            resolvedValue: "1000",
            filePath: "internal/model/entry.go",
            startLine: 20,
          }),
        ],
      }),
    ]);
    expect(sheet.candidates).toBe(1);
    expect(sheet.facts).toHaveLength(1);
  });

  it("skips what is not a named value: a guard, a validation, an unnamed formula", () => {
    const sheet = buildFactSheet([
      mod("a", "RULES\n- `CheckLimit` `CheckLimit`\nFORMULAS\n- `CheckLimit`", {
        minedRules: [
          { ...constant("CheckLimit", "5"), kind: "guard" },
          { ...constant("CheckLimit", "5"), summary: "Rejects when CheckLimit > 5" },
        ],
        formulas: [
          formula({ name: null, expression: "a * 2" }),
          formula({ kind: "validation", name: "CheckLimit", expression: "a * 2" }),
        ],
      }),
    ]);
    expect(sheet.candidates).toBe(0);
  });

  it("keeps a fact's id when its value changes, and tells names and files apart", () => {
    const at = (value: string, name = "MaxEntryLimit", file = "internal/model/entry.go") =>
      buildFactSheet([
        mod("m", `RULES\n- \`${name}\`\nFORMULAS\n- \`${name}\``, {
          minedRules: [{ ...constant(name, value), file }],
        }),
      ]).facts[0];
    expect(at("1000").id).toBe(at("2000").id);
    expect(at("1000").id).toMatch(/^cf-[0-9a-f]{10}$/);
    expect(at("1000", "MaxFeedLimit").id).not.toBe(at("1000").id);
    expect(at("1000", "MaxEntryLimit", "client/model.go").id).not.toBe(at("1000").id);
  });

  it("ranks by how many places mention a fact, and counts the ones past the cap", () => {
    // One fixture past FACT_SHEET_MAX: 70 shared constants, mentioned 2 to 4 times.
    const names = Array.from({ length: FACT_SHEET_MAX + 10 }, (_, i) => `sharedLimit${i}`);
    const mention = (times: number) => (n: string, i: number) =>
      i % 3 < times ? `- \`${n}\`` : "";
    const facts = (times: number) =>
      ["RULES", ...names.map(mention(3)), "FORMULAS", ...names.map(mention(times))].join("\n");
    const sheet = buildFactSheet([
      mod("a", facts(3), { minedRules: names.map((n, i) => constant(n, String(i + 1), i + 1)) }),
      mod("b", facts(1)),
    ]);
    expect(sheet.facts).toHaveLength(FACT_SHEET_MAX);
    expect(sheet.overCap).toBe(10);
    expect(sheet.candidates).toBe(FACT_SHEET_MAX + 10);
    const mentions = sheet.facts.map((f) => f.mentions);
    expect([...mentions].sort((x, y) => y - x)).toEqual(mentions);
    // Nothing vanished: on the sheet, or counted as over the cap.
    expect(sheet.facts.length + sheet.overCap + sheet.notShared + sheet.ambiguous).toBe(
      sheet.candidates,
    );
    expect(buildFactSheet([mod("a", facts(3))], { maxFacts: 0 }).facts).toEqual([]);
  });

  it("cuts an over-long value and says so with an ellipsis", () => {
    const long = `count * ${"ratePerUnitOfWork * ".repeat(12)}2`;
    const sheet = buildFactSheet([
      mod("a", "RULES\n- `computeTotal`\nFORMULAS\n- `computeTotal`", {
        formulas: [
          formula({ expression: long, name: "total", symbolContext: "a.go::computeTotal" }),
        ],
      }),
    ]);
    expect(sheet.facts[0].value).toHaveLength(FACT_VALUE_MAX_CHARS);
    expect(sheet.facts[0].value.endsWith("…")).toBe(true);
  });

  it("reads identifiers in linear time", () => {
    expectLinearTime("identifiersOf", (size) => {
      const text = "`weeklyCount` (a.b.c) ".repeat(Math.ceil(size / 22));
      return () => identifiersOf(text);
    });
    expectLinearTime("classifyFactValue", (size) => {
      const value = `1 ${" ".repeat(size)}`;
      return () => classifyFactValue(value, "arithmetic");
    });
  });
});

describe("giving the sheet to a section", () => {
  const sheet = buildFactSheet(schedulerProject());
  const owner = (id: string): string =>
    ({ rules: "Business Rules", formulas: "Calculations" })[id] ?? id;

  it("gives a text the facts it mentions, by whole word", () => {
    expect(factsMentionedIn(sheet, "calls ScheduleNextCheck daily").map((f) => f.name)).toEqual([
      "ScheduleNextCheck.interval",
    ]);
    expect(factsMentionedIn(sheet, "ScheduleNextCheckAt and MaxEntryLimits")).toEqual([]);
    expect(factsMentionedIn(undefined, "MaxEntryLimit")).toEqual([]);
    expect(factsMentionedIn({ facts: [] }, "MaxEntryLimit")).toEqual([]);
  });

  it("renders nothing without facts, so a prompt without a sheet is unchanged", () => {
    expect(renderCanonicalFactsBlock([], { id: "rules", label: "Business Rules" }, owner)).toBe("");
  });

  it("names each fact's id, value, source line and owner, and says how to use it", () => {
    const block = renderCanonicalFactsBlock(
      sheet.facts,
      { id: "rules", label: "Business Rules" },
      owner,
    );
    const [interval, limit] = sheet.facts;
    expect(block).toContain(
      `[${CANONICAL_SOURCE_PREFIX}${limit.id}] MaxEntryLimit = 1000 | internal/model/entry.go:20 | owner: THIS section`,
    );
    expect(block).toContain(
      `[${canonicalSourceId(interval)}] ScheduleNextCheck.interval = (7 * 24`,
    );
    expect(block).toContain("| internal/model/feed.go:131 | owner: Calculations");
    expect(block).toContain("State one of these values ONLY as it is given here");
    expect(block).toContain("Do not re-derive it, restate its formula or redefine its variables");
    expect(block).toContain(`e.g. [${canonicalSourceId(interval)}]`);
    expect(block.startsWith("=== CANONICAL FACTS")).toBe(true);
    expect(block.endsWith("=== END CANONICAL FACTS ===")).toBe(true);
  });

  it("lists at most the per-call limit and counts the rest in the block", () => {
    // One fixture past FACT_SHEET_MAX_PER_CALL.
    const many: CanonicalFact[] = Array.from({ length: FACT_SHEET_MAX_PER_CALL + 7 }, (_, i) => ({
      ...sheet.facts[0],
      id: `cf-${String(i).padStart(10, "0")}`,
      name: `sharedLimit${i}`,
    }));
    const block = renderCanonicalFactsBlock(many, { id: "rules", label: "Business Rules" }, owner);
    expect(block.match(/^\[facts:canon:/gm)).toHaveLength(FACT_SHEET_MAX_PER_CALL);
    expect(block).toContain("(7 more canonical facts are not listed for this call.)");
    const one = renderCanonicalFactsBlock(many.slice(0, 3), { id: "x", label: "X" }, owner, 2);
    expect(one).toContain("(1 more canonical fact is not listed for this call.)");
  });

  it("records every given fact's value in the section's reuse inputs", () => {
    const before = factSheetFingerprint(sheet.facts);
    const changed = factSheetFingerprint(
      sheet.facts.map((f) => (f.name === "MaxEntryLimit" ? { ...f, value: "2000" } : f)),
    );
    expect(before).toHaveLength(2);
    expect(changed[1]).not.toBe(before[1]);
    expect(changed[0]).toBe(before[0]);
  });
});

describe("a fact as a citable source", () => {
  const limit = buildFactSheet(schedulerProject()).facts.find((f) => f.name === "MaxEntryLimit")!;

  it("carries the value and the source line as the judge's evidence", () => {
    const source = canonicalFactSource({
      ...limit,
      repository: { codeGraphId: "g", repoConnectorId: "r" },
    });
    expect(source).toEqual({
      sourceId: `facts:canon:${limit.id}`,
      kind: "facts",
      label: "internal/model/entry.go:20 — MaxEntryLimit = 1000",
      text: "CANONICAL FACT (read from the source code at internal/model/entry.go:20): MaxEntryLimit = 1000",
      repository: { codeGraphId: "g", repoConnectorId: "r" },
      evidenceClass: "repository-source",
    });
    expect(canonicalFactSource(limit)).not.toHaveProperty("repository");
  });

  it("joins a section's sources after its own, without changing the context", () => {
    const base: GroundingContext = {
      sources: [{ sourceId: "rag:d:1", kind: "rag", label: "doc", text: "t" }],
      sourceIds: new Set(["rag:d:1"]),
      isEmpty: false,
    };
    const merged = withCanonicalSources(base, [limit, limit])!;
    expect(merged.sources.map((s) => s.sourceId)).toEqual(["rag:d:1", `facts:canon:${limit.id}`]);
    expect(merged.sourceIds.has(`facts:canon:${limit.id}`)).toBe(true);
    expect(base.sources).toHaveLength(1);
    expect(base.sourceIds.size).toBe(1);
    // Nothing to add: the very same context (or none).
    expect(withCanonicalSources(base, [])).toBe(base);
    expect(withCanonicalSources(undefined, [])).toBeUndefined();
    expect(withCanonicalSources(undefined, [limit])!.isEmpty).toBe(false);
  });

  it("renders a cited fact as a footnote that shows the source line and the value", () => {
    const source = canonicalFactSource(limit);
    expect(readableSourceReference(source)).toBe(
      "`internal/model/entry.go:20 — MaxEntryLimit = 1000` (canonical fact, read from the source)",
    );
    const rendered = renderCitationFootnotes(
      `A page holds at most 1000 entries [${source.sourceId}].`,
      [source],
    );
    expect(rendered).toBe(
      "A page holds at most 1000 entries[^src-1].\n\n" +
        "[^src-1]: `internal/model/entry.go:20 — MaxEntryLimit = 1000` (canonical fact, read from the source)",
    );
  });
});
