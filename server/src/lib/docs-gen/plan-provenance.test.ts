/**
 * #1070 — the topic plan and the consistency check as the provenance manifest
 * records them, and as the Provenance panel's summary reads them back.
 */
import { describe, expect, it } from "vitest";
import { planDocument, type SectionDemand } from "./document-plan.js";
import { MAX_LISTED_STATEMENTS, type ConsistencyReport } from "./fact-consistency.js";
import {
  buildGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "./generated-doc-provenance.js";
import { summarizeGeneratedDocVersionManifest } from "./generated-doc-version-reads.js";
import {
  MAX_RECORDED_DROPPED_TOPICS,
  MAX_RECORDED_FINDINGS,
  MAX_RECORDED_TEXT_CHARS,
  consistencyRecord,
  topicPlanRecord,
} from "./plan-provenance.js";
import { docsGenTuning, type Phase2ProviderBundle } from "./holistic-synthesizer.js";

const topics = (section: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${section}/m${i}`,
    title: `m${i} — ${section}`,
    priority: count - i,
    estimatedChars: 1_000,
  }));

const SECTIONS: SectionDemand[] = [
  { sectionId: "overview", label: "Overview & Domain", kind: "single", topics: [] },
  { sectionId: "rules", label: "Business Rules", kind: "enumerative", topics: topics("rules", 40) },
];

const LABELS: Record<string, string> = { overview: "Overview & Domain", rules: "Business Rules" };

const report = (findings: ConsistencyReport["findings"], statements = 9): ConsistencyReport => ({
  findings,
  statements,
  compared: Math.min(statements, 4),
});

const manifestInput = (
  extra: Pick<Parameters<typeof buildGeneratedDocVersionManifest>[0], "topicPlan" | "consistency">,
): Parameters<typeof buildGeneratedDocVersionManifest>[0] => {
  const tuning = docsGenTuning("anthropic", "m");
  return {
    revision: { projectId: "p1", generatedDocumentId: "d1", version: 1 },
    title: "BRD",
    scope: "full",
    docType: "business-requirements",
    generatedAt: new Date("2026-10-21T00:00:00Z"),
    policy: {
      projectId: "p1",
      generatedDocumentId: "d1",
      actor: { userId: "u", role: "admin" },
      aclSubjects: [],
      sharedDocumentIds: [],
      allowWebResearch: false,
    },
    phase1Tuning: tuning,
    phase2Router: { primary: { tuning } as Phase2ProviderBundle, hybrid: null },
    phase1PromptVersion: 1,
    selectedEvidence: [],
    graphFingerprint: null,
    sourceRepositories: [],
    sections: [],
    ...extra,
  };
};

describe("topicPlanRecord", () => {
  it("records each section's budget, planned count and drops, most important first", () => {
    // 20,000 characters for 41k of asks: the rules section cannot plan all 40.
    const plan = planDocument({
      sections: SECTIONS,
      documentMaxChars: 20_000,
      sectionMaxChars: 60_000,
    });
    const record = topicPlanRecord(plan, (id) => LABELS[id]);
    expect(record.version).toBe(plan.version);
    expect(record.budgetChars).toBe(20_000);
    expect(record.budgetChars).toBe(
      record.unallocatedChars + record.sections.reduce((n, s) => n + s.budgetChars, 0),
    );
    const [overview, rules] = record.sections;
    expect(overview).toEqual({
      sectionLabel: "Overview & Domain",
      kind: "single",
      budgetChars: plan.sections[0].budgetChars,
      plannedTopics: 1,
      dropped: [],
      droppedNotListed: 0,
    });
    expect(rules.plannedTopics + rules.dropped.length).toBe(40);
    expect(rules.dropped.length).toBeGreaterThan(0);
    // The lowest priority is the last listed: it went first.
    expect(rules.dropped.at(-1)).toBe("m39 — rules");
    expect(rules.dropped).toEqual(plan.sections[1].dropped.map((t) => t.title));
  });

  it("lists a bounded number of drops, clips a long title, and counts the rest", () => {
    const many = MAX_RECORDED_DROPPED_TOPICS + 7;
    const long = topics("rules", many).map((t, i) =>
      i === 0 ? t : { ...t, title: `${"x".repeat(MAX_RECORDED_TEXT_CHARS + 50)}${i}` },
    );
    const plan = planDocument({
      sections: [{ sectionId: "rules", label: "Rules", kind: "enumerative", topics: long }],
      documentMaxChars: 1_000,
      sectionMaxChars: 60_000,
    });
    const [rules] = topicPlanRecord(plan, (id) => id).sections;
    expect(rules.dropped).toHaveLength(MAX_RECORDED_DROPPED_TOPICS);
    expect(rules.droppedNotListed).toBe(
      plan.sections[0].dropped.length - MAX_RECORDED_DROPPED_TOPICS,
    );
    for (const title of rules.dropped)
      expect(title.length).toBeLessThanOrEqual(MAX_RECORDED_TEXT_CHARS);
    expect(rules.dropped[0].endsWith("…")).toBe(true);
  });
});

describe("consistencyRecord", () => {
  it("records a clean check as an answer: the statements read and no finding", () => {
    expect(consistencyRecord(report([], 395))).toEqual({
      statements: 395,
      compared: 4,
      findingCount: 0,
      findings: [],
    });
  });

  it("records each finding with where it is, and the source's value when it has one", () => {
    const record = consistencyRecord(
      report([
        {
          kind: "conflict",
          name: "MaxEntryLimit",
          canonical: { value: "1000", source: "internal/model/entry.go:20" },
          statements: [{ section: "API", line: 3, value: "100" }],
          sections: 1,
          forms: 2,
        },
        {
          kind: "count",
          name: "authentication kinds",
          statements: [
            { section: "Overview", line: 1, value: "five authentication mechanisms" },
            { section: "Capabilities", line: 9, value: "four authentication paths" },
          ],
          sections: 2,
          forms: 2,
        },
      ]),
    );
    expect(record.findings).toEqual([
      {
        kind: "conflict",
        name: "MaxEntryLimit",
        sections: 1,
        forms: 2,
        statements: [{ section: "API", value: "100" }],
        source: { value: "1000", location: "internal/model/entry.go:20" },
      },
      {
        kind: "count",
        name: "authentication kinds",
        sections: 2,
        forms: 2,
        statements: [
          { section: "Overview", value: "five authentication mechanisms" },
          { section: "Capabilities", value: "four authentication paths" },
        ],
      },
    ]);
  });

  it("records a bounded number of findings and statements, and counts every finding", () => {
    const finding = (i: number) => ({
      kind: "size" as const,
      name: `token ${i}`,
      statements: Array.from({ length: MAX_LISTED_STATEMENTS + 3 }, (_, j) => ({
        section: `S${j}`,
        line: j + 1,
        value: "y".repeat(MAX_RECORDED_TEXT_CHARS + 10),
      })),
      sections: MAX_LISTED_STATEMENTS + 3,
      forms: 2,
    });
    const record = consistencyRecord(
      report(Array.from({ length: MAX_RECORDED_FINDINGS + 4 }, (_, i) => finding(i))),
    );
    expect(record.findingCount).toBe(MAX_RECORDED_FINDINGS + 4);
    expect(record.findings).toHaveLength(MAX_RECORDED_FINDINGS);
    expect(record.findings[0].statements).toHaveLength(MAX_LISTED_STATEMENTS);
    expect(record.findings[0].statements[0].value.length).toBe(MAX_RECORDED_TEXT_CHARS);
  });
});

describe("the provenance manifest and its summary", () => {
  const plan = topicPlanRecord(
    planDocument({ sections: SECTIONS, documentMaxChars: 20_000, sectionMaxChars: 60_000 }),
    (id) => LABELS[id],
  );
  const consistency = consistencyRecord(
    report([
      {
        kind: "endpoint",
        name: "/v1/entries/{}/save",
        statements: [
          { section: "Integrations", line: 1, value: "POST /v1/entries/{id}/save" },
          { section: "Integrations", line: 3, value: "PUT /v1/entries/{id}/save" },
        ],
        sections: 1,
        forms: 2,
      },
    ]),
  );

  it("keeps the plan and the check through a write and a read, and shows them in the summary", () => {
    const parsed = parseGeneratedDocVersionManifest(
      buildGeneratedDocVersionManifest(manifestInput({ topicPlan: plan, consistency })),
    );
    expect(parsed.topicPlan).toEqual(plan);
    expect(parsed.consistency).toEqual(consistency);
    const summary = summarizeGeneratedDocVersionManifest(parsed);
    expect(summary.topicPlan).toEqual(plan);
    expect(summary.consistency).toEqual(consistency);
  });

  it("writes neither for a document that was not planned, and reads a manifest without them", () => {
    const parsed = parseGeneratedDocVersionManifest(
      buildGeneratedDocVersionManifest(manifestInput({})),
    );
    expect(parsed).not.toHaveProperty("topicPlan");
    expect(parsed).not.toHaveProperty("consistency");
    const summary = summarizeGeneratedDocVersionManifest(parsed);
    expect(summary).not.toHaveProperty("topicPlan");
    expect(summary).not.toHaveProperty("consistency");
  });

  it("rejects a finding kind the check does not produce, and a title past the cap", () => {
    const raw = JSON.parse(
      buildGeneratedDocVersionManifest(manifestInput({ topicPlan: plan, consistency })),
    );
    raw.consistency.findings[0].kind = "guess";
    expect(() => parseGeneratedDocVersionManifest(raw)).toThrow();
    const long = JSON.parse(
      buildGeneratedDocVersionManifest(manifestInput({ topicPlan: plan, consistency })),
    );
    long.topicPlan.sections[1].dropped[0] = "z".repeat(MAX_RECORDED_TEXT_CHARS + 1);
    expect(() => parseGeneratedDocVersionManifest(long)).toThrow();
  });
});
