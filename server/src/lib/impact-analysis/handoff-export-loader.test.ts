/**
 * Issue #2595 — `loadHandoffChangeRequest`: the change request an impact run
 * was started from, read for the hand-off as its reader may see it. The access
 * rules it composes (`changeRequestRef`, `loadChangeRequestSource`,
 * `seesRunAsWhole`) have their own tests; these prove it calls them with the
 * run's scope and honours what they answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImpactAnalysisDetail } from "@metis/shared";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  changeRequestRef: vi.fn(),
  loadChangeRequestSource: vi.fn(),
  getStructuredRequirements: vi.fn(),
  seesRunAsWhole: vi.fn(),
}));

vi.mock("../prisma.js", () => ({ prisma: { requirement: { findMany: m.findMany } } }));
vi.mock("../analysis/change-request-source.js", () => ({
  changeRequestRef: m.changeRequestRef,
  loadChangeRequestSource: m.loadChangeRequestSource,
}));
vi.mock("../analysis/analysis-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analysis/analysis-service.js")>()),
  getStructuredRequirements: m.getStructuredRequirements,
}));
vi.mock("../analysis/source-redaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analysis/source-redaction.js")>()),
  seesRunAsWhole: m.seesRunAsWhole,
}));

const { loadHandoffChangeRequest } = await import("./handoff-export.js");

const reader = { userId: "user-1" } as never;
const detail = {
  id: "ia-1",
  sourceAnalysisId: "cr-1",
  projectIds: ["project-001", "project-002"],
} as unknown as ImpactAnalysisDetail;

function requirementRow(id: string, title: string, approved = true) {
  return { id, title, body: `${title} body`, acceptanceCriteria: null, approved, sourceIds: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.changeRequestRef.mockResolvedValue({ id: "cr-1", projectId: "project-001", title: "CR" });
  m.loadChangeRequestSource.mockResolvedValue({
    id: "cr-1",
    projectId: "project-001",
    title: "Expiring API keys",
    restrictedLeftOut: 1,
    requirements: [
      requirementRow("r-1", "Paired"),
      requirementRow("r-2", "Raw source", false),
      requirementRow("r-3", "Other run"),
      requirementRow("r-4", "Unpaired"),
    ],
  });
  m.findMany.mockResolvedValue([
    {
      id: "r-1",
      verdict: "gap-confirmed",
      promotedStructuredId: "REQ-001",
      promotedStructuredRunId: "run-2",
    },
    {
      id: "r-2",
      verdict: "could-not-verify",
      promotedStructuredId: "REQ-002",
      promotedStructuredRunId: null,
    },
    { id: "r-3", verdict: null, promotedStructuredId: "REQ-001", promotedStructuredRunId: "run-1" },
  ]);
  m.seesRunAsWhole.mockResolvedValue(true);
  m.getStructuredRequirements.mockResolvedValue({
    runId: "run-2",
    totalAmbiguities: 0,
    totalEvidenceNeeds: 0,
    requirements: [
      {
        id: "REQ-001",
        title: "Paired",
        rawSource: "ignored when there are sources",
        sources: [
          {
            ref: "S1",
            documentId: "doc-1",
            filename: "FRD.md",
            headingPath: ["FRD", "Keys"],
            quote: "A key may expire.",
          },
          { ref: "S2", headingPath: [], quote: "No filename here." },
        ],
      },
      { id: "REQ-002", title: "Raw source", rawSource: "  The raw paragraph.  " },
    ],
  });
});

describe("loadHandoffChangeRequest — #2595", () => {
  it("returns null, reading nothing else, when the run has no readable change request", async () => {
    m.changeRequestRef.mockResolvedValue(null);
    expect(await loadHandoffChangeRequest(detail, reader)).toBeNull();
    expect(m.changeRequestRef).toHaveBeenCalledWith("cr-1", detail.projectIds, reader);
    expect(m.loadChangeRequestSource).not.toHaveBeenCalled();
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("reads the change request only within the run's projects, as the reader", async () => {
    await loadHandoffChangeRequest(detail, reader);
    const [id, canRead, who] = m.loadChangeRequestSource.mock.calls[0]!;
    expect(id).toBe("cr-1");
    expect(who).toBe(reader);
    expect(await canRead("project-002")).toBe(true);
    expect(await canRead("project-999")).toBe(false);
  });

  it("scopes the verdict read on the run and its project, not the ids alone", async () => {
    await loadHandoffChangeRequest(detail, reader);
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["r-1", "r-2", "r-3", "r-4"] },
          analysisId: "cr-1",
          projectId: "project-001",
        },
      }),
    );
  });

  it("states each requirement with its verdict and the passages of its pairing", async () => {
    const out = await loadHandoffChangeRequest(detail, reader);
    expect(out).not.toBeNull();
    expect(out!.title).toBe("Expiring API keys");
    expect(out!.restrictedLeftOut).toBe(1);
    expect(out!.passagesWithheld).toBe(false);
    const [paired, raw, otherRun, unpaired] = out!.requirements;
    expect(paired).toEqual({
      title: "Paired",
      body: "Paired body",
      approved: true,
      verdict: "gap-confirmed",
      passages: [
        { filename: "FRD.md", headingPath: ["FRD", "Keys"], quote: "A key may expire." },
        { headingPath: [], quote: "No filename here." },
      ],
    });
    // No sources: the extraction's raw source is the passage.
    expect(raw!.approved).toBe(false);
    expect(raw!.verdict).toBe("could-not-verify");
    expect(raw!.passages).toEqual([{ headingPath: [], quote: "  The raw paragraph.  " }]);
    // #1202 — a pairing from another extraction run names another list's REQ-001.
    expect(otherRun!.passages).toEqual([]);
    expect(otherRun!.verdict).toBeNull();
    expect(unpaired!.passages).toEqual([]);
    expect(unpaired!.verdict).toBeNull();
  });

  it("shows no passage, and reads no extraction, for a reader who cannot see the run whole", async () => {
    m.seesRunAsWhole.mockResolvedValue(false);
    const out = await loadHandoffChangeRequest(detail, reader);
    expect(m.seesRunAsWhole).toHaveBeenCalledWith(reader, "cr-1");
    expect(m.getStructuredRequirements).not.toHaveBeenCalled();
    expect(out!.passagesWithheld).toBe(true);
    expect(out!.requirements.every((r) => r.passages.length === 0)).toBe(true);
    // The verdicts are the requirement rows' own, and still shown.
    expect(out!.requirements[0]!.verdict).toBe("gap-confirmed");
  });

  it("reads no rows for a change request with no requirement left to state", async () => {
    m.loadChangeRequestSource.mockResolvedValue({
      id: "cr-1",
      projectId: "project-001",
      title: "Empty",
      restrictedLeftOut: 3,
      requirements: [],
    });
    m.getStructuredRequirements.mockResolvedValue(null);
    const out = await loadHandoffChangeRequest(detail, reader);
    expect(m.findMany).not.toHaveBeenCalled();
    expect(out).toEqual({
      title: "Empty",
      restrictedLeftOut: 3,
      passagesWithheld: false,
      requirements: [],
    });
  });
});
