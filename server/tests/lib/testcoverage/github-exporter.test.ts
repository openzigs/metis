/**
 * GitHub exporter tests — issue #876.
 *
 * Mocks `prisma.issueDraft.create` plus `publishing-service`'s `createBatch`
 * and `executeBatch` so we can assert the exporter wires drafts → batch
 * correctly without hitting the database or GitHub.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const draftCreate = vi.fn();
const createBatch = vi.fn();
const executeBatch = vi.fn();

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    issueDraft: { create: (...args: unknown[]) => draftCreate(...args) },
  },
}));

vi.mock("../../../src/lib/publishing/publishing-service.js", () => ({
  createBatch: (...args: unknown[]) => createBatch(...args),
  executeBatch: (...args: unknown[]) => executeBatch(...args),
}));

const importExporter = async () => import("../../../src/lib/testcoverage/index.js");

beforeEach(() => {
  draftCreate.mockReset();
  createBatch.mockReset();
  executeBatch.mockReset();
});

function sample(
  o: Partial<import("../../../src/lib/testcoverage/index.js").ExportableSuggestion> = {},
) {
  return {
    id: "s-1",
    title: "Login flow",
    gwt: { given: ["valid user"], when: ["submit"], then: ["dashboard"] },
    steps: [{ action: "open page", expected: "form visible" }, { action: "submit form" }],
    priority: "high" as const,
    preconditions: "user must exist",
    expected: undefined,
    tags: ["smoke"],
    mappedRequirementIds: ["REQ-1", "REQ-2"],
    faithfulness: 0.92,
    lowConfidence: false,
    ...o,
  };
}

describe("renderTestCaseBody", () => {
  it("renders all required sections with GWT and metadata", async () => {
    const { renderTestCaseBody } = await importExporter();
    const body = renderTestCaseBody(sample());
    expect(body).toContain("## Acceptance Criteria (Given / When / Then)");
    expect(body).toContain("**Given**");
    expect(body).toContain("- valid user");
    expect(body).toContain("**When**");
    expect(body).toContain("- submit");
    expect(body).toContain("**Then**");
    expect(body).toContain("- dashboard");
    expect(body).toContain("## Preconditions");
    expect(body).toContain("user must exist");
    expect(body).toContain("## Steps");
    expect(body).toContain("1. open page → form visible");
    expect(body).toContain("2. submit form");
    expect(body).toContain("## Mapped Requirements");
    expect(body).toContain("- REQ-1");
    expect(body).toContain("- REQ-2");
    expect(body).toContain("Suggestion ID: `s-1`");
    expect(body).toContain("Faithfulness: 0.92");
  });

  it("falls back to _(none)_ for empty fields", async () => {
    const { renderTestCaseBody } = await importExporter();
    const body = renderTestCaseBody(
      sample({
        preconditions: undefined,
        mappedRequirementIds: [],
        steps: [],
        expected: undefined,
        gwt: { given: [], when: [], then: [] },
      }),
    );
    expect(body).toContain("## Preconditions\n\n_(none)_");
    expect(body).toContain("## Steps\n\n_(none)_");
    expect(body).toContain("## Mapped Requirements\n\n_(none)_");
  });
});

describe("exportSuggestionsToGithub", () => {
  it("returns previews and no DB writes on dry-run", async () => {
    const { exportSuggestionsToGithub } = await importExporter();
    const r = await exportSuggestionsToGithub([sample()], {
      projectId: "p1",
      targetOwner: "o",
      targetRepo: "r",
      actorId: "u1",
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.batchId).toBeNull();
    expect(r.draftIds).toEqual([]);
    expect(r.previews).toHaveLength(1);
    expect(r.previews[0].labels).toContain("type:test");
    expect(r.previews[0].labels).toContain("smoke");
    expect(draftCreate).not.toHaveBeenCalled();
    expect(createBatch).not.toHaveBeenCalled();
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("creates drafts, batch, and executes for live run; metadata captured", async () => {
    draftCreate.mockResolvedValueOnce({ id: "d1" }).mockResolvedValueOnce({ id: "d2" });
    createBatch.mockResolvedValue({ id: "batch-9" });
    executeBatch.mockResolvedValue({});

    const { exportSuggestionsToGithub } = await importExporter();
    const r = await exportSuggestionsToGithub(
      [sample({ id: "a" }), sample({ id: "b", lowConfidence: true })],
      {
        projectId: "p1",
        targetOwner: "o",
        targetRepo: "r",
        actorId: "u1",
        additionalLabels: ["release:next"],
      },
    );

    expect(r.batchId).toBe("batch-9");
    expect(r.draftIds).toEqual(["d1", "d2"]);
    expect(draftCreate).toHaveBeenCalledTimes(2);

    const firstDraftCall = draftCreate.mock.calls[0][0];
    expect(firstDraftCall.data.projectId).toBe("p1");
    expect(firstDraftCall.data.draftType).toBe("task");
    expect(firstDraftCall.data.requirementId).toBe("REQ-1");
    expect(firstDraftCall.data.dedupHash).toBe("a");
    const meta = JSON.parse(firstDraftCall.data.metadata);
    expect(meta).toMatchObject({
      source: "test-coverage-export",
      suggestionId: "a",
      faithfulness: 0.92,
      lowConfidence: false,
    });
    const labels = JSON.parse(firstDraftCall.data.labels);
    expect(labels).toContain("type:test");
    expect(labels).toContain("release:next");

    const batchInput = createBatch.mock.calls[0][0];
    expect(batchInput.input.draftIds).toEqual(["d1", "d2"]);
    expect(batchInput.input.provider).toBe("github");
    expect(batchInput.input.targetOwner).toBe("o");
    expect(batchInput.actorId).toBe("u1");

    expect(executeBatch).toHaveBeenCalledWith({ batchId: "batch-9", actorId: "u1" });
  });

  it("returns empty result when no suggestions provided", async () => {
    const { exportSuggestionsToGithub } = await importExporter();
    const r = await exportSuggestionsToGithub([], {
      projectId: "p1",
      targetOwner: "o",
      targetRepo: "r",
      actorId: "u1",
    });
    expect(r.batchId).toBeNull();
    expect(r.draftIds).toEqual([]);
    expect(r.previews).toEqual([]);
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("maps storyPoints for every priority bucket on live run", async () => {
    draftCreate
      .mockResolvedValueOnce({ id: "d-critical" })
      .mockResolvedValueOnce({ id: "d-high" })
      .mockResolvedValueOnce({ id: "d-low" })
      .mockResolvedValueOnce({ id: "d-medium-default" });
    createBatch.mockResolvedValue({ id: "batch-sp" });
    executeBatch.mockResolvedValue({});

    const { exportSuggestionsToGithub } = await importExporter();
    await exportSuggestionsToGithub(
      [
        sample({ id: "a", priority: "critical" }),
        sample({ id: "b", priority: "high" }),
        sample({ id: "c", priority: "low" }),
        sample({ id: "d", priority: "medium" }),
      ],
      {
        projectId: "p1",
        targetOwner: "o",
        targetRepo: "r",
        actorId: "u1",
      },
    );

    expect(draftCreate.mock.calls[0][0].data.storyPoints).toBe(5);
    expect(draftCreate.mock.calls[1][0].data.storyPoints).toBe(3);
    expect(draftCreate.mock.calls[2][0].data.storyPoints).toBe(1);
    expect(draftCreate.mock.calls[3][0].data.storyPoints).toBe(2);
  });
});
