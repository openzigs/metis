/**
 * #1070 — the cross-section consistency check: it reads the sections for the
 * values they state, reports a value stated differently in two places and a
 * canonical formula written out in more than one section, and changes nothing.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import type { CanonicalFact } from "./canonical-facts.js";
import {
  MAX_LISTED_FINDINGS,
  MAX_LISTED_STATEMENTS,
  checkFactConsistency,
  comparableValue,
  factInconsistentWarning,
  normalizeForm,
  scanFactStatements,
} from "./fact-consistency.js";
import { affectsDocStatus, deriveDocStatus } from "./grounding/degraded-warnings.js";

const fact = (over: Partial<CanonicalFact>): CanonicalFact => ({
  id: "cf-0000000001",
  name: "MaxEntryLimit",
  kind: "constant",
  value: "1000",
  file: "internal/model/entry.go",
  line: 20,
  terms: ["MaxEntryLimit"],
  ownerSectionId: "rules",
  modulePath: "internal/model",
  mentions: 2,
  ...over,
});

/** The scheduler interval as the Go extractor stored it in #706 run 7. */
const INTERVAL = fact({
  id: "cf-0000000002",
  name: "ScheduleNextCheck.interval",
  kind: "formula",
  value:
    "(7 * 24 * time.Hour) / time.Duration(weeklyCount*config.Opts.SchedulerEntryFrequencyFactor())",
  file: "internal/model/feed.go",
  line: 131,
  terms: ["ScheduleNextCheck"],
  ownerSectionId: "formulas",
});

/** The four ways run 7 wrote that formula, in the shapes it used. */
const RUN7_SECTIONS = [
  {
    label: "Core Business Capabilities",
    markdown: [
      "- **Scheduled refresh interval** — computed from a weekly fetch count:",
      "$$",
      "\\text{interval} = \\frac{7 \\cdot 24\\,\\text{h}}{\\text{weeklyCount} \\cdot \\text{SchedulerEntryFrequencyFactor}}",
      "$$",
      "",
      "Where `weeklyCount` is the number of refreshes per week.",
    ].join("\n"),
  },
  {
    label: "Business Rules & Policies",
    markdown: [
      "Under entry frequency a feed with history is polled at:",
      "$$",
      "\\text{interval} = \\frac{7 \\times 24\\text{h}}{\\text{weeklyCount} \\times \\text{factor}}",
      "$$",
    ].join("\n"),
  },
  {
    label: "Key Workflows",
    markdown:
      "   - `entry_frequency` scheduler: `interval = (7×24h) / (weeklyCount × factor)`, clamped to the bounds.",
  },
  {
    label: "Calculations & Formulas",
    markdown: [
      "$$",
      "\\text{interval} = \\frac{7 \\times 24\\ \\text{hours}}{\\text{weeklyCount} \\times \\text{SchedulerEntryFrequencyFactor}}",
      "$$",
      "",
      "| Formula | Purpose |",
      "|---|---|",
      "| `7×24h / (weeklyCount × factor)` | Re-check cadence |",
      "",
      "$$",
      "\\text{weeklyCount} = \\mathrm{COALESCE}\\left(\\mathrm{CEIL}\\left(\\frac{604800}{\\text{avgInterval}}\\right), 0\\right)",
      "$$",
    ].join("\n"),
  },
];

describe("normalizeForm", () => {
  it("writes a LaTeX fraction as a division and drops text wrappers and spacing", () => {
    expect(
      normalizeForm("\\frac{7 \\cdot 24\\,\\text{h}}{\\text{weeklyCount} \\cdot \\text{factor}}"),
    ).toBe("(7*24h)/(weeklyCount*factor)");
    expect(normalizeForm("\\dfrac{a}{b} \\times \\mathrm{c}")).toBe("(a)/(b)*c");
    expect(normalizeForm("\\left( x \\right) \\leq 5")).toBe("(x)<=5");
    expect(normalizeForm("\\min(a,\\ b)\\quad")).toBe("min(a,b)");
  });

  it("writes every multiplication and division sign the same way", () => {
    expect(normalizeForm("7×24h / (weeklyCount × factor)")).toBe("7*24h/(weeklyCount*factor)");
    expect(normalizeForm("a · b ⋅ c ÷ d")).toBe("a*b*c/d");
  });

  it("drops code and math delimiters and a trailing full stop", () => {
    expect(normalizeForm("`round_robin`.")).toBe("round_robin");
    expect(normalizeForm("$x + 1$,")).toBe("x+1");
  });

  it("does not fail on unbalanced or nested braces", () => {
    expect(normalizeForm("\\frac{a}{b")).toBe("(a)/(b");
    expect(normalizeForm("}}{{")).toBe("");
    expect(normalizeForm("\\frac{\\frac{a}{b}}{c}")).toBe("((a)/(b))/(c)");
    expect(normalizeForm("\\frac{a} + {b}")).toBe("(a)/+b");
    expect(normalizeForm("a\\")).toBe("a");
  });
});

describe("scanFactStatements", () => {
  it("reads an assignment in a code span", () => {
    expect(scanFactStatements("The limit is `MaxEntryLimit = 1000` per page.")).toEqual([
      { name: "MaxEntryLimit", raw: "1000", form: "1000", line: 1, kind: "assignment" },
    ]);
    expect(scanFactStatements("`total := count * 2`")[0]).toEqual(
      expect.objectContaining({ name: "total", form: "count*2", kind: "assignment" }),
    );
  });

  it("does not read a comparison as an assignment", () => {
    expect(scanFactStatements("`weeklyCount == 0` and `a >= b` and `x != y`")).toEqual([]);
  });

  it("reads a default stated after a name, with its unit but not the next word", () => {
    const stated = scanFactStatements(
      [
        "| Cadence | `POLLING_FREQUENCY` (default 60 min) | freshness |",
        "- `BATCH_SIZE` defaults to 100 feeds per run.",
        "- `POLLING_SCHEDULER` (default `round_robin`)",
        '- `LOG_FORMAT`: default "text".',
        "- `CLEANUP_DAYS` — the default is 30 days.",
      ].join("\n"),
    );
    expect(stated.map((s) => [s.name, s.form, s.line])).toEqual([
      ["POLLING_FREQUENCY", "60min", 1],
      ["BATCH_SIZE", "100", 2],
      ["POLLING_SCHEDULER", "round_robin", 3],
      ["LOG_FORMAT", '"text"', 4],
      ["CLEANUP_DAYS", "30days", 5],
    ]);
    for (const s of stated) expect(s.kind).toBe("default");
  });

  it("does not carry a default across a table cell or far along the line", () => {
    expect(scanFactStatements("| `POLLING_FREQUENCY` | default 60 |")).toEqual([]);
    expect(
      scanFactStatements(
        "`POLLING_FREQUENCY` is read once at start-up and then again later; default 60",
      ),
    ).toEqual([]);
  });

  it("reads inline and display math, a multi-line block as one statement", () => {
    const stated = scanFactStatements(RUN7_SECTIONS[0].markdown);
    expect(stated).toEqual([
      expect.objectContaining({
        name: "interval",
        form: "(7*24h)/(weeklyCount*SchedulerEntryFrequencyFactor)",
        line: 2,
        kind: "assignment",
      }),
    ]);
    expect(scanFactStatements("so $ratio = a / b$ holds, and $$x = y * 2$$ too")).toEqual([
      expect.objectContaining({ name: "ratio", form: "a/b" }),
      expect.objectContaining({ name: "x", form: "y*2" }),
    ]);
    expect(scanFactStatements("$$ total = a + b $$")[0]).toEqual(
      expect.objectContaining({ name: "total", form: "a+b" }),
    );
  });

  it("reads a bare expression in a table cell", () => {
    expect(scanFactStatements("| `7×24h / (weeklyCount × factor)` | cadence |")).toEqual([
      {
        name: null,
        raw: "7×24h / (weeklyCount × factor)",
        form: "7*24h/(weeklyCount*factor)",
        line: 1,
        kind: "expression",
      },
    ]);
  });

  it("skips fenced code, whichever fence, and resumes after it", () => {
    const md = [
      "```go",
      "`MaxEntryLimit = 5`",
      "$$",
      "```",
      "~~~~",
      "`MaxEntryLimit = 6`",
      "```",
      "~~~~",
      "`MaxEntryLimit = 7`",
    ].join("\n");
    expect(scanFactStatements(md).map((s) => [s.form, s.line])).toEqual([["7", 9]]);
  });

  it("reads CRLF text the same as LF text", () => {
    const lf = RUN7_SECTIONS.map((s) => s.markdown).join("\n\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(scanFactStatements(crlf)).toEqual(scanFactStatements(lf));
    expect(scanFactStatements(lf).length).toBeGreaterThan(4);
  });

  it("stops at an unclosed span and reads on from the next line", () => {
    const md = ["an unclosed `span and $math on one line", "`MaxEntryLimit = 1000`"].join("\n");
    // A stray backtick does not hide the math that follows it on the line.
    expect(scanFactStatements("a stray ` and then $total = a + b$ here")).toEqual([
      expect.objectContaining({ name: "total", form: "a+b" }),
    ]);
    expect(scanFactStatements(md).map((s) => s.line)).toEqual([2]);
  });

  it("treats an unclosed $$ block as ended after a bounded number of lines", () => {
    const md = [
      "$$",
      "x = y * 2",
      ...Array.from({ length: 60 }, () => "prose"),
      "`MaxEntryLimit = 1000`",
    ];
    const stated = scanFactStatements(md.join("\n"));
    expect(stated.map((s) => s.name)).toEqual(["x", "MaxEntryLimit"]);
    // And a block still open at the end of the text is read, not lost.
    expect(scanFactStatements("$$\ntotal = a + b").map((s) => s.name)).toEqual(["total"]);
  });

  it("reads at most the first 400 characters of one statement", () => {
    // One fixture past the statement bound: the value is compared on its
    // opening, never dropped.
    const long = `\`MaxEntryLimit = ${"1".repeat(600)}\``;
    const [statement] = scanFactStatements(long);
    expect(statement.name).toBe("MaxEntryLimit");
    expect(statement.form).toHaveLength(400 - "MaxEntryLimit = ".length);
  });

  it("never changes the text it reads", () => {
    const md = Object.freeze(RUN7_SECTIONS.map((s) => s.markdown).join("\n\n"));
    const copy = `${md}`;
    scanFactStatements(md);
    expect(md).toBe(copy);
  });

  it("is linear in the text, whatever it is made of", () => {
    const shapes: Record<string, string> = {
      "backtick runs": "` `` ``` ",
      "unclosed spans": "`a = b ",
      "dollar signs": "$ $$ $",
      assignments: "`A_b = 5` ",
      defaults: "`A_b` (default 5 min) ",
      "equals signs": "= == := ",
      "table pipes": "| `a*b` | $c/d$ ",
      "nested fractions": "$\\frac{\\frac{a}{b}}{c}$ ",
      "open braces": "${{{{",
      "math lines": "$$\nx = y\n",
      "fence lines": "```\n~~~\n",
      "default with no value": "`A_b` default default default ",
    };
    for (const [label, unit] of Object.entries(shapes)) {
      expectLinearTime(`scanFactStatements: ${label}`, (size) => {
        const text = unit.repeat(Math.ceil(size / unit.length));
        return () => scanFactStatements(text);
      });
    }
    expectLinearTime("scanFactStatements: one long line", (size) => {
      const text = "`A_b = 5` and `B_c` (default 7) ".repeat(Math.ceil(size / 32));
      return () => scanFactStatements(text);
    });
    expectLinearTime("normalizeForm: braces", (size) => {
      const text = `${"\\frac{".repeat(size / 12)}${"}".repeat(size / 12)}`;
      return () => normalizeForm(text);
    });
  });
});

describe("comparableValue", () => {
  it("compares numbers as numbers and durations in one unit", () => {
    expect(comparableValue("1,000")).toBe("number:1000");
    expect(comparableValue("1_000")).toBe("number:1000");
    expect(comparableValue("60min")).toBe(comparableValue("1h"));
    expect(comparableValue("24hours")).toBe(comparableValue("1day"));
    expect(comparableValue("30s")).toBe("duration:30");
    expect(comparableValue("500ms")).toBe("duration:0.5");
  });

  it("keeps another unit in a class of its own", () => {
    expect(comparableValue("16mb")).toBe("mb:16");
    expect(comparableValue("50%")).toBe("%:50");
    expect(comparableValue("16mb")).not.toBe(comparableValue("16"));
  });

  it("compares literals as written, and does not compare an expression", () => {
    expect(comparableValue('"text"')).toBe("literal:text");
    expect(comparableValue("round_robin")).toBe("literal:round_robin");
    expect(comparableValue("min(a,b)")).toBeNull();
    expect(comparableValue("a*2")).toBeNull();
  });
});

describe("checkFactConsistency", () => {
  it("finds the run-7 scheduler formula written out in four sections, in four forms", () => {
    const report = checkFactConsistency(RUN7_SECTIONS, { facts: [INTERVAL] });
    expect(report.findings).toEqual([
      {
        kind: "restated",
        name: "ScheduleNextCheck.interval",
        canonical: { value: INTERVAL.value, source: "internal/model/feed.go:131" },
        statements: [
          expect.objectContaining({ section: "Core Business Capabilities", line: 2 }),
          expect.objectContaining({ section: "Business Rules & Policies", line: 2 }),
          expect.objectContaining({ section: "Key Workflows", line: 1 }),
          expect.objectContaining({ section: "Calculations & Formulas", line: 1 }),
          expect.objectContaining({ section: "Calculations & Formulas", line: 7 }),
        ],
        sections: 4,
        forms: 4,
      },
    ]);
    // The weekly-count formula shares one name with it and none of its numbers.
    expect(report.findings[0].statements.map((s) => s.value).join(" ")).not.toContain("604800");
    expect(report.statements).toBe(6);
  });

  it("does not report a formula written out in one section only", () => {
    const report = checkFactConsistency([RUN7_SECTIONS[3]], { facts: [INTERVAL] });
    expect(report.findings).toEqual([]);
  });

  it("does not match an expression on one shared name alone", () => {
    const report = checkFactConsistency(
      [
        { label: "A", markdown: "`total = weeklyCount / 52`" },
        { label: "B", markdown: "`limit = weeklyCount * 3`" },
      ],
      { facts: [INTERVAL] },
    );
    expect(report.findings).toEqual([]);
  });

  it("matches on two of the formula's names with no number in common", () => {
    const report = checkFactConsistency(
      [
        {
          label: "A",
          markdown: "`interval = week / (weeklyCount * SchedulerEntryFrequencyFactor)`",
        },
        {
          label: "B",
          markdown: "$\\text{weeklyCount} \\times \\text{SchedulerEntryFrequencyFactor}$",
        },
      ],
      { facts: [INTERVAL] },
    );
    expect(report.findings).toEqual([expect.objectContaining({ kind: "restated", sections: 2 })]);
  });

  it("never matches a sheet formula that has no distinctive name", () => {
    const plain = fact({ kind: "formula", name: "next.args", value: "len(e.args) + 1" });
    const report = checkFactConsistency(
      [
        { label: "A", markdown: "`n = len(args) + 1`" },
        { label: "B", markdown: "`m = len(args) + 1`" },
      ],
      { facts: [plain] },
    );
    expect(report.findings).toEqual([]);
  });

  it("does not judge a name the sheet does not hold: a state change is not a conflict", () => {
    // The four cases of the #1113 review: ordinary prose of a workflow section.
    const sections = [
      {
        label: "Key Workflows",
        markdown: [
          'A new entry is stored with `entry_status = "unread"`.',
          'Opening it sets `entry_status = "read"`.',
          "The flag starts as `isRead = false` and becomes `isRead = true`.",
          "A fetch begins with `retryCount = 0` and stops at `retryCount = 3`.",
        ].join("\n\n"),
      },
      {
        label: "Business Rules & Policies",
        markdown: "Users get `pageSize` (default 50); admins get `pageSize` (default 100).",
      },
    ];
    const report = checkFactConsistency(sections, { facts: [fact({})] });
    expect(report.statements).toBe(8);
    expect(report.findings).toEqual([]);
    expect(factInconsistentWarning(report)).toBeNull();
    // Nor without a sheet at all.
    expect(checkFactConsistency(sections).findings).toEqual([]);
  });

  it("reports only the statements that differ from the sheet's value, with where each is", () => {
    const pageSize = fact({ name: "defaultPageSize", value: "50", line: 31 });
    const report = checkFactConsistency(
      [
        { label: "Overview", markdown: "`defaultPageSize` (default 50)" },
        { label: "Glossary", markdown: "| `defaultPageSize` (default 100) | page length |" },
        { label: "API", markdown: "`defaultPageSize = 25` and `otherPageSize = 7`" },
      ],
      { facts: [pageSize] },
    );
    expect(report.findings).toEqual([
      {
        kind: "conflict",
        name: "defaultPageSize",
        canonical: { value: "50", source: "internal/model/entry.go:31" },
        statements: [
          { section: "Glossary", line: 1, value: "100" },
          { section: "API", line: 1, value: "25" },
        ],
        sections: 2,
        // 100, 25 and the source's 50.
        forms: 3,
      },
    ]);
  });

  it("lists its findings by code unit, not by the locale of the Node build", () => {
    // `Z` (U+005A) is before `a` (U+0061) by code unit and after it in every
    // locale's collation. Stated in the other order, so neither the order of
    // the statements nor of the sheet gives the answer.
    const report = checkFactConsistency(
      [{ label: "API", markdown: "`aaaPageSize = 25` and `ZzzPageSize = 26`" }],
      {
        facts: [
          fact({ name: "aaaPageSize", value: "50" }),
          fact({ name: "ZzzPageSize", value: "50" }),
        ],
      },
    );
    expect(report.findings.map((f) => `${f.kind} ${f.name}`)).toEqual([
      "conflict ZzzPageSize",
      "conflict aaaPageSize",
    ]);
  });

  it("does not report one value spelled two ways", () => {
    const report = checkFactConsistency(
      [
        { label: "A", markdown: "`POLLING_FREQUENCY` (default 60 min); `MaxEntryLimit = 1,000`" },
        { label: "B", markdown: "`POLLING_FREQUENCY` (default 1 hour); `MaxEntryLimit = 1000`" },
      ],
      { facts: [fact({}), fact({ name: "POLLING_FREQUENCY", value: "60min" })] },
    );
    expect(report.findings).toEqual([]);
  });

  it("does not compare a bare number with a duration, or a value with an expression", () => {
    // 1440 (minutes) and 24h are the same setting: the check cannot know, so it says nothing.
    const report = checkFactConsistency(
      [
        { label: "A", markdown: "`MAX_INTERVAL` (default 1440); `nextCheckAt = now`" },
        { label: "B", markdown: "`MAX_INTERVAL` (default 24h); `nextCheckAt = now + interval`" },
      ],
      {
        facts: [
          fact({ name: "MAX_INTERVAL", value: "1440" }),
          fact({ name: "nextCheckAt", value: "later" }),
        ],
      },
    );
    expect(report.findings.map((f) => [f.name, f.statements.map((s) => s.value)])).toEqual([
      // `now` against `later` is a literal against a literal; `24h` and the
      // expression are not compared with anything.
      ["nextCheckAt", ["now"]],
    ]);
  });

  it("reports a value that differs from the sheet's, even when stated once", () => {
    const report = checkFactConsistency(
      [{ label: "API", markdown: "At most `MaxEntryLimit = 100` entries are returned." }],
      { facts: [fact({})] },
    );
    expect(report.findings).toEqual([
      {
        kind: "conflict",
        name: "MaxEntryLimit",
        canonical: { value: "1000", source: "internal/model/entry.go:20" },
        statements: [{ section: "API", line: 1, value: "100" }],
        sections: 1,
        forms: 2,
      },
    ]);
    // The sheet's own value, stated, is not a finding.
    expect(
      checkFactConsistency([{ label: "API", markdown: "`MaxEntryLimit = 1000`" }], {
        facts: [fact({})],
      }).findings,
    ).toEqual([]);
  });

  it("does not hold a statement against a sheet value of another kind", () => {
    // The sheet's value is a duration expression; the document's is a number.
    const timeout = fact({ name: "defaultTimeout", value: "20 * time.Second" });
    const report = checkFactConsistency(
      [{ label: "A", markdown: "`defaultTimeout` (default 30)" }],
      { facts: [timeout] },
    );
    expect(report.findings).toEqual([]);
  });

  it("finds nothing in a document that states nothing", () => {
    expect(checkFactConsistency([{ label: "A", markdown: "Plain prose." }])).toEqual({
      findings: [],
      statements: 0,
    });
    expect(checkFactConsistency([])).toEqual({ findings: [], statements: 0 });
  });
});

describe("the fact-inconsistent note", () => {
  it("is informational: it does not degrade the document", () => {
    const warning = factInconsistentWarning(
      checkFactConsistency(RUN7_SECTIONS, { facts: [INTERVAL] }),
    )!;
    expect(warning.kind).toBe("fact-inconsistent");
    expect(warning.severity).toBe("info");
    expect(warning.section).toBe("Document");
    expect(affectsDocStatus(warning)).toBe(false);
    expect(deriveDocStatus([warning])).toBe("ready");
    expect(warning.message).toContain("1 formula written out in more than one section");
    expect(warning.message).toContain(
      "The formula `ScheduleNextCheck.interval` is written out 5 times in 4 sections, in 4 forms",
    );
    expect(warning.message).toContain("in Key Workflows");
    expect(warning.message).toContain("at internal/model/feed.go:131");
    expect(warning.message).toContain("Nothing was removed or changed");
  });

  it("is absent when the check found nothing", () => {
    expect(factInconsistentWarning({ findings: [], statements: 12 })).toBeNull();
  });

  it("counts both kinds, and says a single conflict in the singular", () => {
    const warning = factInconsistentWarning(
      checkFactConsistency(
        [
          ...RUN7_SECTIONS,
          { label: "API", markdown: "At most `MaxEntryLimit = 100` entries are returned." },
        ],
        { facts: [INTERVAL, fact({})] },
      ),
    )!;
    expect(warning.message).toContain(
      "Consistency check: 1 value stated differently from the source and 1 formula written out in more than one section.",
    );
    expect(warning.message).toContain(
      "`MaxEntryLimit` is stated with a value that is not the source's (`100` in API). The source has `1000` at internal/model/entry.go:20.",
    );
  });

  it("spells out a bounded number of findings and statements, and counts the rest", () => {
    // One fixture past each cap.
    const names = Array.from({ length: MAX_LISTED_FINDINGS + 3 }, (_, i) => `SETTING_NUMBER_${i}`);
    const sheet = { facts: names.map((name) => fact({ name, value: "5" })) };
    const sections = [
      { label: "A", markdown: names.map((n) => `\`${n}\` (default 5)`).join("\n") },
      { label: "B", markdown: names.map((n) => `\`${n}\` (default 2)`).join("\n") },
    ];
    const many = factInconsistentWarning(checkFactConsistency(sections, sheet))!;
    expect(many.message).toContain(
      `${MAX_LISTED_FINDINGS + 3} values stated differently from the source`,
    );
    expect(many.message).toContain("And 3 more.");
    expect(many.message).toContain("`SETTING_NUMBER_0`");
    expect(many.message).not.toContain(`\`SETTING_NUMBER_${MAX_LISTED_FINDINGS + 2}\``);

    const repeated = Array.from({ length: MAX_LISTED_STATEMENTS + 2 }, (_, i) => ({
      label: `S${i}`,
      markdown: `\`BATCH_SIZE_LIMIT\` (default ${i + 1})`,
    }));
    const one = factInconsistentWarning(
      checkFactConsistency(repeated, { facts: [fact({ name: "BATCH_SIZE_LIMIT", value: "500" })] }),
    )!;
    expect(one.message).toContain(
      "`BATCH_SIZE_LIMIT` is stated with a value that is not the source's",
    );
    expect(one.message).toContain("; and 2 more)");
  });

  it("cannot break out of its code span or run long", () => {
    const warning = factInconsistentWarning(
      checkFactConsistency(
        [
          { label: "A", markdown: `\`\`LIMIT_VALUE = "a\`b${"x".repeat(300)}"\`\`` },
          { label: "B", markdown: '`LIMIT_VALUE = "c"`' },
        ],
        { facts: [fact({ name: "LIMIT_VALUE", kind: "enumeration", value: '"c"' })] },
      ),
    )!;
    const quoted = warning.message.match(/`[^`]*`/g) ?? [];
    for (const q of quoted) expect(q.length).toBeLessThanOrEqual(82);
    expect(warning.message).toContain("`\"a'b");
  });
});
