/**
 * #1218 — a reader-layout BRD (#1175) whose project has approved requirements
 * lists them, as stored, in its requirements section; without any it keeps
 * the requirements reconstructed from the code under the #1175 lead-in.
 * Through `sectionGroupsFor`, `planDocumentTopics` and
 * `synthesizeFinalDocument`, with a fake model: no network, no database, no
 * live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scoreFaithfulnessMock = vi.hoisted(() => vi.fn());

vi.mock("./grounding/citation-validator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grounding/citation-validator.js")>();
  return { ...actual, scoreFaithfulness: scoreFaithfulnessMock };
});

vi.mock("../finops/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finops/index.js")>();
  return { ...actual, recordUsage: vi.fn() };
});

import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import {
  APPROVED_REQUIREMENTS_HEADING,
  APPROVED_REQUIREMENTS_MODEL,
  approvedRequirementsMaxChars,
  approvedRequirementsPlanChars,
  renderApprovedRequirementsSection,
} from "./approved-requirements-section.js";
import {
  APPENDIX_DIVIDER,
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_TARGET_CHARS,
  REQUIREMENTS_LEAD_IN,
} from "./brd-layout.js";
import {
  docsGenTuning,
  planDocumentTopics,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import { findCodeIdentifiers, MAIN_PART_LANGUAGE_RULES } from "./main-part-language.js";
import type { ScopedRequirement } from "./requirements-scope.js";
import { buildGenerationCheckpoint, type SectionSynthesisRecord } from "./section-reuse.js";

// ── Fixture ───────────────────────────────────────────────────────────────

function mod(name: string): ModuleFacts {
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts: [
      "PURPOSE",
      `${name} handles one business capability.`,
      "RULES",
      `- rule of ${name}: a password is at least 6 characters.`,
      "WORKFLOWS",
      `- step of ${name}: the request is checked.`,
    ].join("\n"),
    formulas: [],
    topClasses: [],
  };
}

const FACTS = Array.from({ length: 6 }, (_, i) => mod(`m${i}`));

function req(n: number, overrides: Partial<ScopedRequirement> = {}): ScopedRequirement {
  return {
    id: `req-${n}`,
    title: `Analyst-edited requirement ${n}`,
    body: `Clarified with the sponsor: requirement ${n} as the analyst left it.`,
    type: "feature",
    priority: "high",
    reviewStatus: "approved",
    verdict: "implemented",
    acceptanceCriteria: JSON.stringify([
      `Given requirement ${n}, when a feed refreshes, then at most 100 entries are kept.`,
      `Requirement ${n}: a password shorter than 6 characters is refused.`,
    ]),
    version: 2,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    codeMappings: [],
    implementations: [],
    ...overrides,
  };
}

// ── Fake model ────────────────────────────────────────────────────────────

interface Call {
  group: string;
}

function fakeModel(overrun = 0.8): AIProvider & { calls: Call[] } {
  const calls: Call[] = [];
  const provider = {
    key: "anthropic",
    model: "fake-section-model",
    offline: false,
    calls,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const group = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      calls.push({ group });
      const words = Number(/write at most about (\d+) words/i.exec(user)?.[1] ?? 300);
      const paragraphs = Math.max(1, Math.round((words * 6 * overrun) / 140));
      const body = Array.from(
        { length: paragraphs },
        (_, p) =>
          `### Topic ${p} of ${group}\n\nThis policy applies to every request the capability receives today.`,
      );
      yield { type: "delta", content: `## ${group}\n\n${body.join("\n\n")}` };
      yield { type: "done", finishReason: "stop" };
    },
    async chat(): Promise<never> {
      throw new Error("chat not used");
    },
    async embed(): Promise<never> {
      throw new Error("embed not used");
    },
    async models(): Promise<string[]> {
      return [];
    },
    async ping(): Promise<boolean> {
      return true;
    },
  };
  return provider as unknown as AIProvider & { calls: Call[] };
}

function routerFor(provider: AIProvider): Phase2Router {
  const tuning = docsGenTuning("anthropic", provider.model);
  const bundle: Phase2ProviderBundle = {
    kind: "anthropic",
    provider,
    supportsCaching: false,
    factsCharCap: tuning.factsCharCap,
    tuning,
  };
  return { primary: bundle, hybrid: null };
}

const META = { name: "Fixture", totalFiles: 40, totalSymbols: 900, language: "go" } as never;
const RECONSTRUCTED = "Requirements Reconstructed from the Code";

function run(
  provider: AIProvider,
  approvedRequirements?: readonly ScopedRequirement[],
  previousManifest?: { sectionSynthesis?: unknown },
  facts: ModuleFacts[] = FACTS,
) {
  return synthesizeFinalDocument(
    facts,
    META,
    "business-requirements",
    "BRD",
    routerFor(provider),
    "p1",
    undefined,
    undefined,
    undefined,
    undefined,
    { effectiveConfigHash: "cfg", previousManifest: previousManifest as never },
    approvedRequirements ? { approvedRequirements } : undefined,
  );
}

/** The markdown of one H2 section, up to the next H1 or H2. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const end = markdown.slice(start + 3).search(/\n#{1,2} /);
  return markdown.slice(start, end < 0 ? undefined : start + 3 + end);
}

function mainPartOf(markdown: string): string {
  const at = markdown.indexOf(APPENDIX_DIVIDER);
  return markdown.slice(markdown.indexOf("\n## ") + 1, at < 0 ? undefined : at).trim();
}

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "100000");
  vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
});
afterEach(() => vi.unstubAllEnvs());

// ── Tests ─────────────────────────────────────────────────────────────────

describe("the reader layout's requirements section", () => {
  it("is the approved requirements when the project has any, with no model instructions", () => {
    const groups = sectionGroupsFor("business-requirements", {
      brdLayout: "reader",
      approvedRequirements: [req(1)],
    });
    const requirements = groups.find((g) => g.id === "requirements")!;
    expect(requirements.label).toBe(APPROVED_REQUIREMENTS_HEADING);
    expect(requirements.instructions).toBe("");
    expect(requirements.approvedRequirements).toEqual([req(1)]);
    // Every other section is unchanged.
    const without = sectionGroupsFor("business-requirements", { brdLayout: "reader" });
    expect(groups.filter((g) => g.id !== "requirements")).toEqual(
      without.filter((g) => g.id !== "requirements"),
    );
    expect(without.find((g) => g.id === "requirements")!.label).toBe(RECONSTRUCTED);
  });

  it("keeps #1223's business-language rules and criteria sentence on the reconstructed fallback", () => {
    const reconstructed = sectionGroupsFor("business-requirements", { brdLayout: "reader" }).find(
      (g) => g.id === "requirements",
    )!;
    expect(reconstructed.instructions.endsWith(MAIN_PART_LANGUAGE_RULES)).toBe(true);
    expect(reconstructed.instructions).toContain(
      "Write each from the point of view of a user, an administrator or the business (what they do, and what they see or get), not as an API or database contract.",
    );
    // The reader main part is still the four sections the budget is sized for.
    const main = sectionGroupsFor("business-requirements", {
      brdLayout: "reader",
      approvedRequirements: [req(1)],
    }).filter((g) => Object.hasOwn(BRD_MAIN_SECTION_TARGETS, g.id));
    expect(main.map((g) => g.id)).toEqual([
      "overview",
      "capabilities",
      "key-rules",
      "requirements",
    ]);
  });

  it("is reconstructed from the code when there are none, and in the catalogue layout", () => {
    const empty = sectionGroupsFor("business-requirements", {
      brdLayout: "reader",
      approvedRequirements: [],
    });
    expect(empty.find((g) => g.id === "requirements")!.label).toBe(RECONSTRUCTED);
    const catalogue = sectionGroupsFor("business-requirements", { approvedRequirements: [req(1)] });
    expect(catalogue.some((g) => g.approvedRequirements)).toBe(false);
    expect(catalogue).toEqual(sectionGroupsFor("business-requirements"));
  });
});

describe("planDocumentTopics with approved requirements", () => {
  const plan = (approvedRequirements: readonly ScopedRequirement[]) =>
    planDocumentTopics({
      facts: FACTS,
      groups: sectionGroupsFor("business-requirements", {
        brdLayout: "reader",
        approvedRequirements,
      }),
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 250_000,
      readerLayout: true,
    }).plan;

  // #1270 — room for the most the section may render to, not its current
  // length, so the plan does not move when the list does.
  it("plans the section, and the main part, at the most the requirements may render to", () => {
    const requirements = [req(1), req(2), req(3)];
    const p = plan(requirements);
    const rendered = renderApprovedRequirementsSection(
      requirements,
      approvedRequirementsMaxChars(p.budgetChars),
    ).markdown.length;
    const section = p.sections.find((s) => s.sectionId === "requirements")!;
    expect(section.budgetChars).toBe(approvedRequirementsMaxChars(p.budgetChars));
    expect(section.budgetChars).toBe(approvedRequirementsPlanChars(p.budgetChars));
    expect(section.budgetChars).toBeGreaterThanOrEqual(rendered);
    expect(p.mainBudgetChars).toBe(
      BRD_MAIN_TARGET_CHARS - BRD_MAIN_SECTION_TARGETS.requirements + section.budgetChars,
    );
    expect(p.mainBudgetChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    // The other main sections get their targets, as without approved requirements.
    for (const id of ["overview", "capabilities", "key-rules"]) {
      expect(p.sections.find((s) => s.sectionId === id)!.budgetChars).toBe(
        BRD_MAIN_SECTION_TARGETS[id],
      );
    }
  });

  it("plans an over-budget set at its share of the main part, never past 60k", () => {
    const p = plan(Array.from({ length: 400 }, (_, i) => req(i + 1)));
    const section = p.sections.find((s) => s.sectionId === "requirements")!;
    expect(section.budgetChars).toBeLessThanOrEqual(approvedRequirementsMaxChars(250_000));
    expect(p.mainBudgetChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
  });
});

describe("a reader-layout document", () => {
  it("lists the approved requirements as stored, with no model call and no reconstructed lead-in", async () => {
    const provider = fakeModel();
    const requirements = [req(1), req(2, { acceptanceCriteria: "[]" })];
    const result = await run(provider, requirements);
    const section = sectionOf(result.markdown, APPROVED_REQUIREMENTS_HEADING);
    expect(section).toContain("> **Approved in METIS.**");
    expect(section).toContain("### R1. Analyst-edited requirement 1");
    expect(section).toContain("**Requirement id:** `req-1`");
    expect(section).toContain("Clarified with the sponsor: requirement 1 as the analyst left it.");
    expect(section).toContain(
      "- Given requirement 1, when a feed refreshes, then at most 100 entries are kept.",
    );
    expect(section).toContain("- Requirement 1: a password shorter than 6 characters is refused.");
    expect(section).toContain("### R2. Analyst-edited requirement 2");
    expect(section).not.toContain("did not fit");
    // In the main part, before the appendix.
    expect(result.markdown.indexOf(section)).toBeLessThan(
      result.markdown.indexOf(APPENDIX_DIVIDER),
    );
    // No model wrote it, and nothing says it was reconstructed.
    expect(provider.calls.map((c) => c.group)).not.toContain(APPROVED_REQUIREMENTS_HEADING);
    expect(provider.calls.map((c) => c.group)).not.toContain(RECONSTRUCTED);
    expect(result.markdown).not.toContain(REQUIREMENTS_LEAD_IN);
    expect(result.markdown).not.toContain(`## ${RECONSTRUCTED}`);
    const manifest = result.sections.find((s) => s.sectionLabel === APPROVED_REQUIREMENTS_HEADING);
    expect(manifest?.model).toBe(APPROVED_REQUIREMENTS_MODEL);
    expect(manifest?.factsSourceIds).toEqual([]);
    expect(result.warnings.filter((w) => w.kind === "section-missing")).toEqual([]);
  });

  it("lists a requirement holding code names verbatim, and leaves it out of the #1223 code identifier check", async () => {
    const provider = fakeModel();
    const body = "The `markAsRead()` call updates entry_status in internal/storage/entry.go.";
    const criterion = "Given `GET /v1/entries`, the user_id column is NOT NULL.";
    const requirements = [
      req(1, { id: "req_12", body, acceptanceCriteria: JSON.stringify([criterion]) }),
    ];
    const result = await run(provider, requirements);
    const section = sectionOf(result.markdown, APPROVED_REQUIREMENTS_HEADING);
    // As the analyst wrote it: nothing stripped, reworded or re-prompted.
    expect(section).toContain("**Requirement id:** `req_12`");
    expect(section).toContain(`\n${body}\n`);
    expect(section).toContain(`- ${criterion}`);
    expect(provider.calls.map((c) => c.group)).not.toContain(APPROVED_REQUIREMENTS_HEADING);
    // The detector would flag it; the section is not checked, so nothing is recorded.
    expect(findCodeIdentifiers(section).length).toBeGreaterThan(0);
    const approved = result.sections.find((s) => s.sectionLabel === APPROVED_REQUIREMENTS_HEADING);
    expect(approved).toBeDefined();
    expect(approved).not.toHaveProperty("codeIdentifiers");
    // The model-written main sections still are.
    const checked = result.sections.filter((s) => s.codeIdentifiers !== undefined);
    expect(checked.map((s) => s.sectionLabel).sort()).toEqual(
      [
        "Core Business Capabilities",
        "Executive Summary, Scope & Domain",
        "Key Business Rules",
      ].sort(),
    );
  });

  it("falls back to the requirements reconstructed from the code, under the #1175 lead-in, when none are approved", async () => {
    const provider = fakeModel();
    const result = await run(provider, []);
    const section = sectionOf(result.markdown, RECONSTRUCTED);
    expect(section.startsWith(`## ${RECONSTRUCTED}\n\n${REQUIREMENTS_LEAD_IN}\n\n`)).toBe(true);
    expect(provider.calls.map((c) => c.group)).toContain(RECONSTRUCTED);
    expect(result.markdown).not.toContain(`## ${APPROVED_REQUIREMENTS_HEADING}`);
  });

  it("lists an over-budget set whole requirements at a time, then points to the full list", async () => {
    // The other main sections overrun their targets fourfold, too.
    const provider = fakeModel(8);
    const requirements = Array.from({ length: 300 }, (_, i) => req(i + 1));
    const result = await run(provider, requirements);
    const section = sectionOf(result.markdown, APPROVED_REQUIREMENTS_HEADING);
    const listed = [...section.matchAll(/^### R(\d+)\. /gm)].length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(300);
    expect(section).toContain(`**${listed} of 300 approved requirements are listed here.**`);
    // Not one listed requirement is cut short: each ends with its last criterion.
    for (let n = 1; n <= listed; n += 1) {
      expect(section).toContain(
        `- Requirement ${n}: a password shorter than 6 characters is refused.`,
      );
    }
    expect(section).not.toContain("Shortened for length");
    expect(section.length).toBeLessThanOrEqual(approvedRequirementsMaxChars(250_000));
    // The main part is still held to its cap: the other sections gave way.
    expect(mainPartOf(result.markdown).length).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    const cut = result.sections.find((s) => s.sectionLabel === APPROVED_REQUIREMENTS_HEADING);
    expect(cut?.omittedTopics ?? []).toEqual([]);
  });

  it("keeps the listed requirements whole under a small document cap, where the plan gives them less", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "90000");
    const provider = fakeModel(8);
    const requirements = Array.from({ length: 300 }, (_, i) => req(i + 1));
    const result = await run(provider, requirements);
    const section = sectionOf(result.markdown, APPROVED_REQUIREMENTS_HEADING);
    const listed = [...section.matchAll(/^### R(\d+)\. /gm)].length;
    expect(listed).toBeGreaterThan(0);
    expect(section).toContain(`**${listed} of 300 approved requirements are listed here.**`);
    expect(section).toContain(
      `- Requirement ${listed}: a password shorter than 6 characters is refused.`,
    );
    expect(section).not.toContain("Shortened for length");
    // Held to half the 90k cap, and the requirements to their share of it.
    expect(mainPartOf(result.markdown).length).toBeLessThanOrEqual(45_000);
    expect(section.length).toBeLessThanOrEqual(approvedRequirementsMaxChars(90_000));
  });

  it("ignores approved requirements in the catalogue layout", async () => {
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "catalogue");
    const provider = fakeModel();
    const result = await run(provider, [req(1)]);
    expect(result.markdown).not.toContain(`## ${APPROVED_REQUIREMENTS_HEADING}`);
    expect(result.markdown).not.toContain(APPENDIX_DIVIDER);
  });
});

describe("per-section reuse (#857) with approved requirements", () => {
  it("records the section, so a second identical run reuses every section and is unchanged", async () => {
    const requirements = [req(1), req(2)];
    const first = await run(fakeModel(), requirements);
    expect(first.sectionSynthesis?.complete).toBe(true);
    const ids = first.sectionSynthesis!.records.map((r) => r.sectionId);
    expect(ids).toContain("requirements");
    expect(ids).toHaveLength(first.sections.length);

    const provider = fakeModel();
    const second = await run(provider, requirements, first);
    expect(second.regeneration).toEqual({ mode: "unchanged", changed: [] });
    expect(provider.calls).toEqual([]);
    expect(second.sectionSynthesis?.complete).toBe(true);
    expect(second.markdown).toBe(first.markdown);
  });

  it("re-renders only the requirements when one is edited, never reusing its old text", async () => {
    const first = await run(fakeModel(), [req(1), req(2)]);
    const provider = fakeModel();
    const edited = [req(1, { title: "Retitled by the analyst" }), req(2)];
    const second = await run(provider, edited, first);
    expect(second.regeneration).toEqual({
      mode: "sections",
      changed: ["requirements"],
      sections: ["requirements"],
    });
    expect(provider.calls).toEqual([]);
    const section = sectionOf(second.markdown, APPROVED_REQUIREMENTS_HEADING);
    expect(section).toContain("### R1. Retitled by the analyst");
    expect(section).not.toContain("Analyst-edited requirement 1");
    expect(second.resume?.stale.map((s) => s.section)).toEqual([APPROVED_REQUIREMENTS_HEADING]);
    // The new record replaces the old: a third identical run is unchanged.
    const third = await run(fakeModel(), edited, second);
    expect(third.regeneration).toEqual({ mode: "unchanged", changed: [] });
  });

  it("counts a write that bumps only version and updatedAt as unchanged (#1230)", async () => {
    const first = await run(fakeModel(), [req(1), req(2)]);
    const bumped = [
      req(1, { version: 7, updatedAt: new Date("2026-10-15T00:00:00Z") }),
      req(2, { version: 3 }),
    ];
    const second = await run(fakeModel(), bumped, first);
    expect(second.regeneration).toEqual({ mode: "unchanged", changed: [] });
    expect(second.resume?.stale).toEqual([]);
  });

  it("checkpoints the section as it is rendered, and a resumed run reuses it from the checkpoint (#1230)", async () => {
    const stored: SectionSynthesisRecord[][] = [];
    const requirements = [req(1), req(2)];
    const synth = (provider: AIProvider, reuse: Parameters<typeof synthesizeFinalDocument>[10]) =>
      synthesizeFinalDocument(
        FACTS,
        META,
        "business-requirements",
        "BRD",
        routerFor(provider),
        "p1",
        undefined,
        undefined,
        undefined,
        undefined,
        reuse,
        { approvedRequirements: requirements },
      );
    const first = await synth(fakeModel(), {
      effectiveConfigHash: "cfg",
      onCheckpoint: async (records) => {
        stored.push([...records]);
      },
    });
    // Saved as soon as it was rendered: some checkpoint holds it before the
    // run's last section is written.
    const at = stored.findIndex((records) => records.some((r) => r.sectionId === "requirements"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(stored.length - 1);
    const record = stored[at].find((r) => r.sectionId === "requirements")!;
    expect(record.markdown).toBe(
      sectionOf(first.markdown, APPROVED_REQUIREMENTS_HEADING).trimEnd(),
    );
    expect(record.metadata.model).toBe(APPROVED_REQUIREMENTS_MODEL);

    // A run that failed after it: resumed from the checkpoint alone, the
    // section is reused, not re-rendered as changed.
    const resumed = await synth(fakeModel(), {
      effectiveConfigHash: "cfg",
      checkpoint: buildGenerationCheckpoint(stored[at]),
    });
    expect(resumed.resume?.reused).toContain(APPROVED_REQUIREMENTS_HEADING);
    expect(resumed.resume?.stale.map((s) => s.section) ?? []).not.toContain(
      APPROVED_REQUIREMENTS_HEADING,
    );
    // An approval since the checkpoint makes the stored copy stale.
    const approvedSince = await synthesizeFinalDocument(
      FACTS,
      META,
      "business-requirements",
      "BRD",
      routerFor(fakeModel()),
      "p1",
      undefined,
      undefined,
      undefined,
      undefined,
      { effectiveConfigHash: "cfg", checkpoint: buildGenerationCheckpoint(stored[at]) },
      { approvedRequirements: [...requirements, req(3)] },
    );
    expect(approvedSince.resume?.stale.map((s) => s.section)).toContain(
      APPROVED_REQUIREMENTS_HEADING,
    );
    expect(sectionOf(approvedSince.markdown, APPROVED_REQUIREMENTS_HEADING)).toContain(
      "### R3. Analyst-edited requirement 3",
    );
  });

  // #1270 — on a budget-limited plan the appendix gets what the main part
  // leaves. While the approved section asked for its rendered length, every
  // approval moved every catalogue section's budget, which is in its reuse
  // hash, so each was written again at model cost.
  // Two caps: at the default 250k the main part gets all it asks and the
  // appendix is at its limit (the case #1270 measured); at 60k the main part
  // is at its limit too, so its own sections share what the approved one
  // leaves. Each with enough modules that the appendix's catalogue outgrows
  // what it is left.
  describe.each([
    ["the appendix", "250000", false, 200],
    ["both parts", "60000", true, 40],
  ])("#1270 — on a budget-limited plan, at the limit of %s", (_part, CAP, mainLimited, modules) => {
    const lines = (kind: string, name: string) =>
      Array.from({ length: 12 }, (_, k) => `- ${kind} ${k} of ${name}: applies to each request.`);
    const MANY: ModuleFacts[] = Array.from({ length: modules }, (_, i) => ({
      ...mod(`m${i}`),
      facts: [
        "PURPOSE",
        `m${i} handles one business capability.`,
        "RULES",
        ...lines("rule", `m${i}`),
        "WORKFLOWS",
        ...lines("step", `m${i}`),
        "FORMULAS",
        ...lines("formula", `m${i}`),
        "ENTITIES",
        ...lines("entity", `m${i}`),
        "INTEGRATIONS",
        `- integration of m${i}: a webhook.`,
      ].join("\n"),
    }));
    const planAt = (approvedRequirements: readonly ScopedRequirement[]) =>
      planDocumentTopics({
        facts: MANY,
        groups: sectionGroupsFor("business-requirements", {
          brdLayout: "reader",
          approvedRequirements,
        }),
        router: routerFor(fakeModel()),
        sectionMaxChars: 60_000,
        documentMaxChars: Number(CAP),
        readerLayout: true,
      }).plan;
    const lists: Array<[string, ScopedRequirement[], ScopedRequirement[]]> = [
      ["another is approved", [req(1), req(2)], [req(1), req(2), req(3)]],
      ["one is un-approved", [req(1), req(2), req(3)], [req(1), req(3)]],
      [
        "one is edited to ten times its length",
        [req(1), req(2)],
        [req(1), req(2, { body: Array.from({ length: 10 }, () => req(2).body).join(" ") })],
      ],
    ];

    it.each(lists)(
      "plans every section but the approved one the same when %s",
      (_, before, after) => {
        const a = planAt(before);
        const b = planAt(after);
        // The fixture is at the limit: an appendix catalogue section is given
        // less than it asked for, so a moved budget would move its hash.
        const appendix = a.sections.filter(
          (s) => s.kind === "enumerative" && !Object.hasOwn(BRD_MAIN_SECTION_TARGETS, s.sectionId),
        );
        expect(appendix.length).toBeGreaterThan(0);
        expect(appendix.some((s) => s.budgetChars < s.demandChars)).toBe(true);
        const otherMain = a.sections.filter(
          (s) =>
            Object.hasOwn(BRD_MAIN_SECTION_TARGETS, s.sectionId) && s.sectionId !== "requirements",
        );
        expect(otherMain.some((s) => s.budgetChars < s.demandChars)).toBe(mainLimited);
        // The lists do render to different lengths.
        expect(
          renderApprovedRequirementsSection(after, approvedRequirementsMaxChars(a.budgetChars))
            .markdown.length,
        ).not.toBe(
          renderApprovedRequirementsSection(before, approvedRequirementsMaxChars(a.budgetChars))
            .markdown.length,
        );
        expect(b.mainBudgetChars).toBe(a.mainBudgetChars);
        expect(b.sections).toEqual(a.sections);
      },
    );

    it.each(lists)("rewrites no model-written section when %s", async (_, before, after) => {
      vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", CAP);
      const first = await run(fakeModel(), before, undefined, MANY);
      expect(first.sectionSynthesis?.complete).toBe(true);
      const provider = fakeModel();
      const second = await run(provider, after, first, MANY);
      expect(second.regeneration).toEqual({
        mode: "sections",
        changed: ["requirements"],
        sections: ["requirements"],
      });
      expect(provider.calls).toEqual([]);
    });

    // What the banner and the user guide still warn of: the first approval
    // swaps the model-written reconstructed section for the approved list,
    // which asks the plan for a different budget.
    it("re-plans the document when the first requirement is approved", () => {
      const reconstructed = planAt([]);
      const approved = planAt([req(1)]);
      const others = (p: typeof approved) =>
        p.sections.filter((s) => s.sectionId !== "requirements").map((s) => s.budgetChars);
      expect(others(approved)).not.toEqual(others(reconstructed));
    });
  });

  it("re-renders the requirements when another is approved", async () => {
    const first = await run(fakeModel(), [req(1)]);
    const second = await run(fakeModel(), [req(1), req(2)], first);
    expect(second.regeneration).toMatchObject({ mode: "sections", changed: ["requirements"] });
    expect(sectionOf(second.markdown, APPROVED_REQUIREMENTS_HEADING)).toContain(
      "### R2. Analyst-edited requirement 2",
    );
  });
});
