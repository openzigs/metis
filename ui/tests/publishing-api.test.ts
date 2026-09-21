/**
 * Lightweight URL/payload coverage for the publishing API wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishingApi } from "@/lib/publishing-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("publishingApi", () => {
  it("hits canonical paths with correct payloads", async () => {
    await publishingApi.listDrafts("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/drafts");

    await publishingApi.generateDrafts("p1", {
      analysisId: "a1",
      targetOwner: "octo",
      targetRepo: "demo",
      defaultLabels: ["v1.2"],
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/drafts/generate", {
      method: "POST",
      body: { analysisId: "a1", targetOwner: "octo", targetRepo: "demo", defaultLabels: ["v1.2"] },
    });

    await publishingApi.approveDraft("p1", "d1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/drafts/d1/approve", {
      method: "POST",
    });

    await publishingApi.listBatches("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/projects/p1/publishing/batches?includeArchived=false",
    );
    await publishingApi.listBatches("p1", true);
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/projects/p1/publishing/batches?includeArchived=true",
    );

    await publishingApi.getBatch("p1", "b1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/batches/b1");

    await publishingApi.createBatch("p1", {
      targetOwner: "octo",
      targetRepo: "demo",
      draftIds: ["d1"],
      provider: "github",
      dryRun: false,
      additionalLabels: [],
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/batches", {
      method: "POST",
      body: {
        targetOwner: "octo",
        targetRepo: "demo",
        draftIds: ["d1"],
        provider: "github",
        dryRun: false,
        additionalLabels: [],
      },
    });

    await publishingApi.archiveBatch("p1", "b1", { reason: "old", closeIssues: true });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/batches/b1/archive", {
      method: "POST",
      body: { reason: "old", closeIssues: true },
    });
  });

  // #1104 (D/F) — the confirmation's plan source, and the stranded-batch remedy.
  it("previews a batch against a dedicated endpoint that creates nothing", async () => {
    const body = {
      targetOwner: "openzigs",
      targetRepo: "example-requirements",
      draftIds: ["d1"],
      provider: "github" as const,
      dryRun: false,
      additionalLabels: [],
    };
    await publishingApi.previewBatch("p1", body);
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/batches/preview", {
      method: "POST",
      body,
    });
  });

  it("cancels a batch by id", async () => {
    await publishingApi.cancelBatch("p1", "b1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/publishing/batches/b1/cancel", {
      method: "POST",
    });
  });
});

describe("reviewGateApi (#619)", () => {
  it("hits the review-gate endpoints with correct payloads", async () => {
    const { reviewGateApi } = await import("@/lib/publishing-api");

    await reviewGateApi.get("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/review-gate");

    await reviewGateApi.update("p1", { requireApprovedReview: true });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/review-gate", {
      method: "PATCH",
      body: { requireApprovedReview: true },
    });
  });
});
