/**
 * SAS workflow + dataset-lineage facts flow into the facts blob (Fix #1).
 *
 * The regex SAS parser captures symbol names/locations and the SAS rule miner
 * captures business RULES, but the per-module FACTS blob the synthesizer builds
 * was body-thin for WORKFLOWS and DATA_LINEAGE — so the Key Workflows and Data &
 * Domain Model sections had nothing concrete to describe and scored ~0%. This
 * test proves the deterministic SAS-workflow/lineage enrichment now:
 *   (1) is PRODUCED by extractModuleFacts (even on the offline path), and
 *   (2) FLOWS into both the generation facts blob (buildRelevantFactsBlob) and
 *       the citable grounding sources (buildSectionFactsSources) for the
 *       workflows + data-model sections.
 *
 * Fully deterministic: prisma + node:fs/promises are mocked; the AI provider is
 * an offline stub (no network, no cache).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";

// Mock prisma BEFORE importing the module under test (route/synth tests pattern).
vi.mock("../prisma.js", () => ({
  prisma: {
    finding: { findMany: vi.fn().mockResolvedValue([]) },
    docsGenFactCache: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock fs so extractModuleFacts reads our in-memory SAS fixture and finds no
// .sql files in the module dir. `vi.hoisted` lets the hoisted vi.mock factory
// AND the test body share the same fixture string.
const { SAS_FIXTURE } = vi.hoisted(() => ({
  SAS_FIXTURE: [
    `%macro risk_calc(asof=, cutoff=0.8);`,
    `data flagged;`,
    `  set raw.exposures;`,
    `  where reporting_date <= &asof;`,
    `  retain cum_exposure 0;`,
    `  if rating in ('CCC','D') then risk_flag = 1;`,
    `  else risk_flag = 0;`,
    `  if amount > 0;`,
    `  keep entity_id amount risk_flag cum_exposure;`,
    `run;`,
    `proc summary data=flagged;`,
    `  class entity_id;`,
    `  output out=rollup;`,
    `run;`,
    `%mend;`,
  ].join("\n"),
}));

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => path.resolve(p)),
  readFile: vi.fn().mockResolvedValue(SAS_FIXTURE),
  // No .sql files in the module dir → SQL mining pass is a no-op.
  readdir: vi.fn().mockResolvedValue([]),
}));

import {
  extractModuleFacts,
  buildRelevantFactsBlob,
  buildSectionFactsSources,
  sectionGroupsFor,
  type ModuleGroup,
} from "./holistic-synthesizer.js";
import type { AIProvider } from "../ai/types.js";

/** Minimal offline provider: forces the deterministic offline facts path. */
function offlineProvider(): AIProvider {
  return {
    key: "offline-stub",
    model: "mock",
    offline: true,
    chat: vi.fn(),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

/** A SAS module group with a macro symbol spanning the whole fixture. */
function sasModule(): ModuleGroup {
  return {
    dir: "sas/etl",
    syms: [
      {
        id: "s1",
        codeGraphId: "graph-a",
        qualifiedName: "risk_calc.sas::risk_calc",
        kind: "function",
        language: "sas",
        filePath: "sas/etl/risk_calc.sas",
        startLine: 1,
        endLine: SAS_FIXTURE.split("\n").length,
      },
    ],
  };
}

const workflowsGroup = () =>
  sectionGroupsFor("business-requirements").find((g) => g.id === "workflows")!;
const dataModelGroup = () =>
  sectionGroupsFor("business-requirements").find((g) => g.id === "data-model")!;

describe("extractModuleFacts — SAS workflow + lineage enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces non-empty WORKFLOWS step facts and DATA_LINEAGE facts for a SAS module", async () => {
    const facts = await extractModuleFacts(sasModule(), offlineProvider(), false, "p1", "/clone");
    expect(facts).not.toBeNull();
    const text = facts!.facts;

    // The deterministic step pipeline is present and source-grounded.
    expect(text).toContain("DETERMINISTIC SAS STEP PIPELINE");
    expect(text).toContain("DATA flagged");
    expect(text).toContain("PROC summary");
    // Real dataset lineage, not meta-commentary about "empty bodies".
    expect(text).toContain("DETERMINISTIC SAS DATASET LINEAGE");
    expect(text).toMatch(/reads \[raw\.exposures\]/);
    expect(text).toMatch(/writes \[flagged\]/);
    expect(text).toMatch(/reads \[flagged\]/); // proc summary reads the data step's output
    expect(text).toMatch(/writes \[rollup\]/);

    // The deterministic WORKFLOWS block carries real step content (the offline
    // stub's placeholder "WORKFLOWS\n(none)" may remain earlier, but the mined
    // pipeline is appended after it, so the section is no longer empty overall).
    const wfIdx = text.indexOf("DETERMINISTIC SAS STEP PIPELINE");
    expect(wfIdx).toBeGreaterThan(-1);
    expect(text.slice(wfIdx)).toContain("DATA flagged");
  });

  it("flows the workflow facts into the Key Workflows generation blob AND citable sources", async () => {
    const facts = await extractModuleFacts(sasModule(), offlineProvider(), false, "p1", "/clone");
    const group = workflowsGroup();

    // (1) Generation: the facts blob the model reads contains the real steps.
    const blob = buildRelevantFactsBlob([facts!], group, "business-requirements", 150_000);
    expect(blob).toContain("DATA flagged");
    expect(blob).toContain("PROC summary");
    expect(blob).toContain("DETERMINISTIC SAS STEP PIPELINE");

    // (2) Grounding: the same module is admitted as a citable facts source whose
    // text carries the steps, so workflow claims can resolve instead of being
    // judged unsupported.
    const sources = buildSectionFactsSources([facts!], group, "business-requirements", 150_000);
    expect(sources.length).toBe(1);
    expect(sources[0].text).toContain("DATA flagged");
    expect(sources[0].text).toContain("DETERMINISTIC SAS STEP PIPELINE");
  });

  it("flows the dataset lineage into the Data & Domain Model blob AND citable sources", async () => {
    const facts = await extractModuleFacts(sasModule(), offlineProvider(), false, "p1", "/clone");
    const group = dataModelGroup();

    const blob = buildRelevantFactsBlob([facts!], group, "business-requirements", 150_000);
    expect(blob).toContain("DETERMINISTIC SAS DATASET LINEAGE");
    expect(blob).toMatch(/reads \[raw\.exposures\]/);

    const sources = buildSectionFactsSources([facts!], group, "business-requirements", 150_000);
    expect(sources.some((s) => /DETERMINISTIC SAS DATASET LINEAGE/.test(s.text))).toBe(true);
  });

  it("does not add SAS workflow facts for a non-SAS (TypeScript) module", async () => {
    const tsModule: ModuleGroup = {
      dir: "src/svc",
      syms: [
        {
          id: "t1",
          codeGraphId: "graph-a",
          qualifiedName: "svc.ts::handler",
          kind: "function",
          language: "ts",
          filePath: "src/svc/svc.ts",
          startLine: 1,
          endLine: 5,
        },
      ],
    };
    const facts = await extractModuleFacts(tsModule, offlineProvider(), false, "p1", "/clone");
    expect(facts!.facts).not.toContain("DETERMINISTIC SAS STEP PIPELINE");
    expect(facts!.facts).not.toContain("DETERMINISTIC SAS DATASET LINEAGE");
  });
});
