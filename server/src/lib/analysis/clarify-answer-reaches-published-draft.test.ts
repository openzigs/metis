/**
 * Issue #1116 — **the regression test that would have caught this.**
 *
 * The reported defect: a user answers clarifying questions, the answers visibly
 * enrich `metadata.structuredRequirements` (which is what the Approvals panel
 * renders), and then the published GitHub issue contains none of it. Searching
 * the live run's published issues for distinctive answer strings — "European
 * Central Bank", "dismissible", "90 days" — returned zero hits in both the
 * published issues AND the persisted `requirements` rows.
 *
 * So this test follows a distinctive token through BOTH hops end to end, using
 * the REAL `persistRequirements`, the REAL enrichment pass and the REAL draft
 * generator over one in-memory Prisma fake:
 *
 *     answer ──▶ Requirement.body ──▶ IssueDraft.body
 *
 * Nothing between the submit and the draft is stubbed. A test that asserted only
 * the first hop (or only `structuredRequirements`) is exactly the test that
 * passed while this bug shipped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesisOutput } from "@metis/shared";
import type { ClarificationState, StructuredRequirements } from "./types/requirements.js";

const ANALYSIS_ID = "an_1116";
const PROJECT_ID = "pr_1116";

/** The distinctive token from the live incident. */
const TOKEN = "European Central Bank";

interface ReqRow {
  id: string;
  analysisId: string;
  projectId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  labels: string;
  acceptanceCriteria: string;
  storyPoints: number | null;
  coverage: string | null;
  verdict: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

interface DraftRow {
  id: string;
  projectId: string;
  requirementId: string | null;
  parentDraftId: string | null;
  draftType: string;
  title: string;
  body: string;
  labels: string;
  assignees: string;
  storyPoints: number;
  status: string;
  dedupHash: string;
  metadata: string;
  deletedAt: Date | null;
}

const store = {
  requirements: [] as ReqRow[],
  drafts: [] as DraftRow[],
  metadata: null as string | null,
  dialogState: null as string | null,
  seq: 0,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: {
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        const before = store.requirements.length;
        store.requirements = store.requirements.filter((r) => r.analysisId !== where.analysisId);
        return { count: before - store.requirements.length };
      }),
      create: vi.fn(async ({ data }: { data: Partial<ReqRow> }) => {
        const row: ReqRow = {
          id: `req-${++store.seq}`,
          analysisId: data.analysisId!,
          projectId: data.projectId!,
          type: data.type ?? "feature",
          title: data.title ?? "",
          body: data.body ?? "",
          priority: data.priority ?? "medium",
          labels: data.labels ?? "[]",
          acceptanceCriteria: data.acceptanceCriteria ?? "[]",
          storyPoints: data.storyPoints ?? null,
          coverage: data.coverage ?? null,
          verdict: data.verdict ?? null,
          createdAt: new Date(),
          deletedAt: null,
        };
        store.requirements.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { analysisId?: string } }) =>
        store.requirements.filter(
          (r) => (!where.analysisId || r.analysisId === where.analysisId) && r.deletedAt === null,
        ),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ReqRow> }) => {
        const row = store.requirements.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === ANALYSIS_ID
          ? { id: ANALYSIS_ID, projectId: PROJECT_ID, metadata: store.metadata, deletedAt: null }
          : null,
      ),
      update: vi.fn(async ({ data }: { data: { metadata: string } }) => {
        store.metadata = data.metadata;
        return { id: ANALYSIS_ID };
      }),
    },
    clarificationDialogState: {
      findUnique: vi.fn(async () => (store.dialogState ? { state: store.dialogState } : null)),
    },
    project: {
      findFirst: vi.fn(async () => ({ id: PROJECT_ID, name: "JPetStore" })),
    },
    issueDraft: {
      findFirst: vi.fn(async ({ where }: { where: { dedupHash: string } }) =>
        store.drafts.find((d) => d.dedupHash === where.dedupHash && d.deletedAt === null),
      ),
      create: vi.fn(async ({ data }: { data: Partial<DraftRow> }) => {
        const row = {
          id: `draft-${++store.seq}`,
          deletedAt: null,
          ...data,
        } as DraftRow;
        store.drafts.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        const row = store.drafts.find((d) => d.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    finding: { findMany: vi.fn(async () => []) },
  },
}));

const { persistRequirements } = await import("./analysis-service.js");
const { applyClarificationsToRequirements } = await import("./clarification-enrichment.js");
const { generateDrafts } = await import("../publishing/draft-generator.js");

/**
 * The synthesized requirement set — produced BEFORE any clarifying question was
 * asked, which is precisely why its body cannot contain the answer.
 */
const SYNTHESIS: SynthesisOutput = {
  summary: "Storefront currency handling",
  requirements: [
    {
      type: "feature",
      title: "Display product prices in the shopper's selected currency",
      body: "Product and cart prices must be converted from the catalogue currency before display.",
      priority: "high",
      labels: ["storefront"],
      acceptanceCriteria: ["Prices render in the selected currency."],
      evidenceFindingIndexes: [],
      storyPoints: 3,
    },
    {
      type: "feature",
      title: "Retire the legacy XML order export",
      body: "The nightly XML export job is replaced by the JSON feed.",
      priority: "low",
      labels: [],
      acceptanceCriteria: [],
      evidenceFindingIndexes: [],
      storyPoints: 2,
    },
  ],
  risks: [],
  assumptions: [],
} as unknown as SynthesisOutput;

const STRUCTURED: StructuredRequirements = {
  requirements: [
    {
      id: "REQ-1",
      title: "Multi-currency price display",
      // Post-clarify description: enriched by the resolution pass. This is the
      // representation the Approvals panel shows — and the one that never
      // reached the artifact.
      description: `Prices are converted using the daily ${TOKEN} reference rate.`,
      type: "functional",
      stakeholders: [],
      priority: "must-have",
      ambiguities: [{ field: "rateSource", description: "which rate?", suggestedQuestion: "?" }],
      evidenceNeeds: [],
      rawSource: "doc",
    },
    {
      id: "REQ-9",
      title: "Loyalty tier accrual thresholds",
      description: "Points accrue per tier.",
      type: "functional",
      stakeholders: [],
      priority: "should-have",
      ambiguities: [],
      evidenceNeeds: [],
      rawSource: "doc",
    },
  ],
  totalAmbiguities: 0,
  totalEvidenceNeeds: 0,
};

const DIALOG: ClarificationState = {
  analysisId: ANALYSIS_ID,
  currentRound: 2,
  maxRounds: 3,
  rounds: [
    {
      round: 1,
      questions: [
        {
          id: "q1",
          requirementId: "REQ-1",
          ambiguityField: "rateSource",
          question: "Which exchange-rate source should conversions use?",
          context: "The requirement does not name a rate provider.",
          answer: `Use the ${TOKEN} daily reference rate, refreshed at 16:00 CET.`,
        },
        {
          id: "q2",
          requirementId: "REQ-9",
          ambiguityField: "window",
          question: "Over what window do loyalty points accrue?",
          context: "No window is stated.",
          answer: "Points accrue over a rolling 90 days.",
        },
        {
          id: "q3",
          requirementId: "REQ-1",
          ambiguityField: "rounding",
          question: "How should converted prices round?",
          context: "",
          answer: "   ",
        },
      ],
      answers: [],
    },
  ],
  resolvedAmbiguities: [],
  escalatedToSonnet: false,
  completed: true,
};

async function persistAndEnrich(): Promise<void> {
  await persistRequirements({
    analysisId: ANALYSIS_ID,
    projectId: PROJECT_ID,
    synthesis: SYNTHESIS,
    findingIdsByIndex: [],
  });
  await applyClarificationsToRequirements(ANALYSIS_ID);
}

const currencyRow = (): ReqRow => store.requirements.find((r) => r.title.includes("currency"))!;

describe("#1116 — a clarify answer reaches the persisted requirement AND the published draft", () => {
  beforeEach(() => {
    store.requirements = [];
    store.drafts = [];
    store.seq = 0;
    store.metadata = JSON.stringify({ structuredRequirements: STRUCTURED });
    store.dialogState = JSON.stringify(DIALOG);
  });

  it("the token is absent from the synthesis output — the answer is the ONLY source of it", () => {
    expect(JSON.stringify(SYNTHESIS)).not.toContain(TOKEN);
  });

  it("HOP 1: the answer lands in the persisted requirement row", async () => {
    await persistAndEnrich();
    expect(currencyRow().body).toContain(TOKEN);
    expect(currencyRow().body).toContain("Which exchange-rate source should conversions use?");
  });

  it("HOP 2: the answer lands in the generated draft body that becomes the GitHub issue", async () => {
    await persistAndEnrich();
    await generateDrafts({
      projectId: PROJECT_ID,
      analysisId: ANALYSIS_ID,
      targetOwner: "openzigs",
      targetRepo: "example-requirements",
    });
    const draft = store.drafts.find((d) => d.requirementId === currencyRow().id)!;
    expect(draft.body).toContain(TOKEN);
    expect(draft.body).toContain("## Clarifications");
  });

  it("without the enrichment pass the draft has NO trace of the answer (the bug, pinned)", async () => {
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: SYNTHESIS,
      findingIdsByIndex: [],
    });
    await generateDrafts({
      projectId: PROJECT_ID,
      analysisId: ANALYSIS_ID,
      targetOwner: "openzigs",
      targetRepo: "example-requirements",
    });
    const draft = store.drafts.find((d) => d.requirementId === currencyRow().id)!;
    expect(draft.body).not.toContain(TOKEN);
  });

  it("leaves an unrelated requirement untouched — answers are attributed, not broadcast", async () => {
    await persistAndEnrich();
    const other = store.requirements.find((r) => r.title.includes("XML"))!;
    expect(other.body).not.toContain(TOKEN);
    expect(other.body).not.toContain("## Clarifications");
  });

  it("preserves the #1110 published-issue structure around the new section", async () => {
    await persistAndEnrich();
    await generateDrafts({
      projectId: PROJECT_ID,
      analysisId: ANALYSIS_ID,
      targetOwner: "openzigs",
      targetRepo: "example-requirements",
    });
    const draft = store.drafts.find((d) => d.requirementId === currencyRow().id)!;
    expect(draft.body).toContain("## Description");
    expect(draft.body).toContain("## Acceptance criteria");
    expect(draft.body).toContain("Prices render in the selected currency.");
    expect(draft.body).toContain("## Definition of done");
    // No panel ran, so #1110 must still publish no Confidence section.
    expect(draft.body).not.toContain("## Confidence");
  });

  it("records what happened to every answer so the UI can say it (AC3)", async () => {
    await persistAndEnrich();
    const meta = JSON.parse(store.metadata!) as {
      clarificationApplication: Record<string, unknown>;
    };
    expect(meta.clarificationApplication).toMatchObject({
      answeredCount: 2, // the blank third answer is not an answer
      appliedCount: 1,
      unattributedCount: 1, // REQ-9 (loyalty) matches no synthesized requirement
      requirementsUpdated: 1,
      requirementsAvailable: true,
    });
  });

  it("is idempotent — re-running replaces the block instead of stacking it", async () => {
    await persistAndEnrich();
    const once = currencyRow().body;
    await applyClarificationsToRequirements(ANALYSIS_ID);
    await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(currencyRow().body).toBe(once);
    expect(currencyRow().body.match(/## Clarifications/g)).toHaveLength(1);
  });

  it("reports 'not yet saved' rather than failing when the approval gate withholds the rows", async () => {
    const application = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(application).toMatchObject({
      answeredCount: 2,
      requirementsAvailable: false,
      requirementsUpdated: 0,
    });
    // …and promotion later applies them to the rows it creates.
    await persistAndEnrich();
    expect(currencyRow().body).toContain(TOKEN);
  });
});
