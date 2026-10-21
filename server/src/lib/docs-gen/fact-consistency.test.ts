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
  endpointKey,
  factInconsistentWarning,
  normalizeForm,
  scanFactStatements,
  scanProseStatements,
  singularWord,
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
      compared: 0,
    });
    expect(checkFactConsistency([])).toEqual({ findings: [], statements: 0, compared: 0 });
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
    expect(factInconsistentWarning({ findings: [], statements: 12, compared: 0 })).toBeNull();
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

/**
 * #1070 (run 8) — the sheet found nothing in a BRD that contradicted itself in
 * prose. These are the run's own lines (trimmed), from its stored sections.
 */
const RUN8_AUTH = [
  {
    label: "Overview & Domain",
    markdown:
      "Access is governed by **five distinct authentication mechanisms**, each of which resolves to the same underlying `User` record.",
  },
  {
    label: "Core Business Capabilities",
    markdown:
      "The product supports four independent authentication paths — local passwords, OAuth2/OpenID Connect, WebAuthn/passkeys, and reverse-proxy header auth — plus API keys for machine access.",
  },
];
const RUN8_SAVE = {
  label: "Integrations & Glossary",
  markdown: [
    "| Entry mutation | `PUT /v1/entries/{id}`, `PUT /v1/entries/{id}/star`, `POST /v1/entries/{id}/save`, `GET /v1/entries/{id}/fetch-content` |",
    "",
    "Eligibility is determined by `HasSaveEntry(userID)`; `PUT /v1/entries/{id}/save` returns **202 Accepted** on success.",
  ].join("\n"),
};

describe("prose statements made in more than one way (#1070, run 8)", () => {
  it("finds run 8's five authentication mechanisms against its four authentication paths", () => {
    const report = checkFactConsistency(RUN8_AUTH);
    expect(report.findings).toEqual([
      {
        kind: "count",
        name: "authentication ways",
        label: "authentication mechanisms",
        statements: [
          {
            section: "Overview & Domain",
            line: 1,
            value: "five distinct authentication mechanisms",
          },
          {
            section: "Core Business Capabilities",
            line: 1,
            value: "four independent authentication paths",
          },
        ],
        sections: 2,
        forms: 2,
      },
    ]);
    expect(factInconsistentWarning(report)!.message).toContain(
      "Consistency check: 1 statement made in more than one way. The number of `authentication mechanisms` is given 2 different ways in 2 sections (`five distinct authentication mechanisms` in Overview & Domain; `four independent authentication paths` in Core Business Capabilities).",
    );
  });

  it("finds run 8's save endpoint given as POST in a table and PUT two lines later", () => {
    const report = checkFactConsistency([RUN8_SAVE]);
    expect(report.findings).toEqual([
      {
        kind: "endpoint",
        name: "/v1/entries/{}/save",
        label: "/v1/entries/{}/save",
        statements: [
          { section: "Integrations & Glossary", line: 1, value: "POST /v1/entries/{id}/save" },
          { section: "Integrations & Glossary", line: 3, value: "PUT /v1/entries/{id}/save" },
        ],
        sections: 1,
        forms: 2,
      },
    ]);
    expect(factInconsistentWarning(report)!.message).toContain("in one section");
  });

  it("reads an endpoint across sections, and not a read beside a write or a line naming both", () => {
    const report = checkFactConsistency([
      { label: "A", markdown: "Create with `POST /v1/feeds/:feedID/refresh`." },
      { label: "B", markdown: "Refresh with `PUT /v1/feeds/{id}/refresh/`." },
      // A read and a write of one path are two operations.
      { label: "C", markdown: "`GET /v1/users/{id}` reads it." },
      { label: "D", markdown: "`PUT /v1/users/{id}` updates it." },
      // One line that names both methods describes both.
      {
        label: "E",
        markdown: "It takes `POST /v1/categories` or `PUT /v1/categories`.",
      },
      { label: "F", markdown: "`POST /v1/categories` creates one." },
    ]);
    expect(report.findings.map((f) => [f.kind, f.name, f.forms])).toEqual([
      ["endpoint", "/v1/feeds/{}/refresh", 2],
    ]);
  });

  it("reads one count of a kind once, and not a count that is not of a qualified kind", () => {
    const same = checkFactConsistency([
      { label: "A", markdown: "There are three entry states: unread, read, removed." },
      { label: "B", markdown: "Entries move between 3 entry statuses." },
    ]);
    expect(same.findings).toEqual([]);
    const differ = checkFactConsistency([
      { label: "A", markdown: "There are three entry states: unread, read, removed." },
      { label: "B", markdown: "Entries have two entry statuses, unread and read." },
    ]);
    expect(differ.findings.map((f) => [f.kind, f.name])).toEqual([["count", "entry states"]]);
    // Filler alone qualifies nothing, and "of the" / "to" make another phrase.
    const unqualified = checkFactConsistency([
      { label: "A", markdown: "Five distinct mechanisms. Two of the types. Three ways to log in." },
      { label: "B", markdown: "Four distinct mechanisms. Six of the types. Two ways to log in." },
    ]);
    expect(unqualified.findings).toEqual([]);
  });

  it("does not compare one section with itself, nor read fenced code or a math block", () => {
    const report = checkFactConsistency([
      {
        label: "A",
        markdown: "Two retry modes for feeds, and later three retry modes for bookmarks.",
      },
      { label: "B", markdown: "```\nfive retry modes\n```\n$$\nfour retry modes\n$$" },
    ]);
    expect(report.findings).toEqual([]);
    expect(scanProseStatements("```\nfive retry modes\n```")).toEqual([]);
    expect(scanProseStatements("$$\nfour retry modes\n$$\nsix retry modes")).toEqual([
      expect.objectContaining({ kind: "count", value: "6", line: 4 }),
    ]);
  });

  it("compares a size only in one unit, and only of a qualified thing", () => {
    const report = checkFactConsistency([
      {
        label: "A",
        markdown:
          "Each user gets a 64-character API token; the verifier is a 32-character hex string.",
      },
      {
        label: "B",
        markdown:
          "API keys are 32 byte API tokens. A 32-character API token is shown once. State is a 24-character hex string.",
      },
    ]);
    // 64 against 32 characters is a finding; 32 bytes is another unit; a
    // "hex string" says what it is no more than "a string" does.
    expect(report.findings).toEqual([
      {
        kind: "size",
        name: "api token in characters",
        label: "API token (characters)",
        statements: [
          { section: "A", line: 1, value: "64-character API token" },
          { section: "B", line: 1, value: "32-character API token" },
        ],
        sections: 2,
        forms: 2,
      },
    ]);
    expect(factInconsistentWarning(report)!.message).toContain(
      "The size of `API token (characters)` is given 2 different ways in 2 sections",
    );
  });

  it("counts prose statements with the others, and lists them after the sheet's findings", () => {
    const report = checkFactConsistency(
      [...RUN8_AUTH, { label: "API", markdown: "At most `MaxEntryLimit = 100` entries." }],
      { facts: [fact({})] },
    );
    expect(report.statements).toBe(3);
    expect(report.findings.map((f) => f.kind)).toEqual(["conflict", "count"]);
    expect(factInconsistentWarning(report)!.message).toContain(
      "Consistency check: 1 value stated differently from the source and 1 statement made in more than one way.",
    );
  });

  it("does not read unrelated nouns, a decimal or PUT beside PATCH as a contradiction (PR #1316 review)", () => {
    const report = checkFactConsistency([
      {
        label: "A",
        markdown: [
          "It accepts two file paths and two payment methods.",
          "Version 1.5 release types are listed below.",
          "| Update | `PUT /v1/users/{id}` |",
        ].join("\n"),
      },
      {
        label: "B",
        markdown: [
          "It accepts three file types and three payment options.",
          "There are 3 release types.",
          "Partial updates use `PATCH /v1/users/{id}`.",
        ].join("\n"),
      },
    ]);
    expect(report.findings).toEqual([]);
    // A count of a different decimal is still not read; a plain one is.
    expect(scanProseStatements("v2 release types; 1,5 release types; 4 release types")).toEqual([
      expect.objectContaining({ kind: "count", value: "4" }),
    ]);
    // POST against PUT or PATCH still is (run 8).
    const post = checkFactConsistency([
      { label: "A", markdown: "`PATCH /v1/users/{id}` updates." },
      { label: "B", markdown: "`POST /v1/users/{id}` updates." },
    ]);
    expect(post.findings.map((f) => f.kind)).toEqual(["endpoint"]);
  });

  it("reads a non-breaking hyphen as a hyphen", () => {
    const report = checkFactConsistency([
      { label: "A", markdown: "A 64\u2011character API token." },
      { label: "B", markdown: "A 32\u2010character API token." },
    ]);
    expect(report.findings.map((f) => [f.kind, f.label])).toEqual([
      ["size", "API token (characters)"],
    ]);
  });

  it("counts as compared only the statements that had something to compare with", () => {
    const report = checkFactConsistency(
      [
        {
          label: "A",
          markdown:
            "`GET /v1/me` reads. Five authentication mechanisms. Two retry modes. `MaxEntryLimit = 1000`.",
        },
        { label: "B", markdown: "Five authentication paths. `otherLimit = 7`." },
      ],
      { facts: [fact({})] },
    );
    // Read: the GET (as an endpoint, and as the expression its code span
    // holds), two counts in A, one in B, two assignments.
    expect(report.statements).toBe(7);
    // Compared: the two authentication counts (A and B) and the sheet value.
    expect(report.compared).toBe(3);
    expect(report.findings).toEqual([]);
  });

  it("normalises a path and a word as the comparison needs", () => {
    expect(endpointKey("/v1/feeds/{feedID}/entries/:entryID/")).toBe("/v1/feeds/{}/entries/{}");
    expect(endpointKey("/v1/me.")).toBe("/v1/me");
    expect(singularWord("entries")).toBe("entry");
    expect(singularWord("statuses")).toBe("status");
    expect(singularWord("hashes")).toBe("hash");
    expect(singularWord("access")).toBe("access");
    expect(singularWord("feeds")).toBe("feed");
    expect(singularWord("ids")).toBe("ids");
  });

  it("reads prose in linear time, whatever repeats", () => {
    for (const [label, unit] of [
      ["count openers", "five "],
      ["count phrases", "five authentication "],
      ["size openers", "64-character "],
      ["endpoint openers", "POST /"],
      ["endpoint paths", "POST /v1/{id}/x "],
    ] as const) {
      expectLinearTime(`scanProseStatements: ${label}`, (size) => {
        const text = unit.repeat(Math.ceil(size / unit.length));
        return () => scanProseStatements(text);
      });
    }
  });
});
