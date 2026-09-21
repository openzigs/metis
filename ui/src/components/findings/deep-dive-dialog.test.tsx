/**
 * Deep-dive dialog tests — focused on the #744 export/copy actions.
 *
 * Once the draft has loaded (editing phase), the dialog exposes "Export markdown"
 * (server-serialized download) and "Copy issue draft" (server-serialized markdown
 * → clipboard). Both post the CURRENT edited draft to the export endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import type { FindingIssueDraft } from "@/lib/analysis-api";

const deepDiveFinding = vi.fn();
const exportFindingIssueDraftMarkdown = vi.fn();
const exportFindingIssueDraft = vi.fn();

vi.mock("@/lib/analysis-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      deepDiveFinding: (...a: unknown[]) => deepDiveFinding(...a),
      exportFindingIssueDraftMarkdown: (...a: unknown[]) => exportFindingIssueDraftMarkdown(...a),
      exportFindingIssueDraft: (...a: unknown[]) => exportFindingIssueDraft(...a),
    },
  };
});

const triggerDownload = vi.fn();
vi.mock("@/lib/plugins-api", () => ({
  triggerDownload: (...a: unknown[]) => triggerDownload(...a),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));

import { DeepDiveDialog } from "./deep-dive-dialog";

const DRAFT: FindingIssueDraft = {
  title: "Add rate limiting",
  problemStatement: "No throttling.",
  affected: { files: ["auth.ts"], requirementIds: ["REQ-1"] },
  acceptanceCriteria: ["Limited to 5/min"],
  suggestedLabels: ["security"],
};

function renderDialog() {
  render(
    <DeepDiveDialog
      open
      onOpenChange={() => {}}
      projectId="proj-1"
      analysisId="an-1"
      finding={{ id: "f-1", title: "Login has no throttle", agentKey: "code" }}
    />,
  );
}

describe("DeepDiveDialog export actions (#744)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deepDiveFinding.mockResolvedValue({ draft: DRAFT, meta: { tokensUsed: 1, model: "haiku" } });
    // jsdom has no clipboard by default.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => cleanup());

  it("downloads the issue-draft markdown from the current draft", async () => {
    exportFindingIssueDraftMarkdown.mockResolvedValue({
      blob: new Blob(["# draft"]),
      filename: "issue-draft-f-1.md",
    });
    renderDialog();
    const btn = await screen.findByTestId("deep-dive-export-md");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(exportFindingIssueDraftMarkdown).toHaveBeenCalledWith(
        "proj-1",
        "an-1",
        "f-1",
        expect.objectContaining({ title: "Add rate limiting" }),
      ),
    );
    await waitFor(() => expect(triggerDownload).toHaveBeenCalled());
  });

  it("copies the server-serialized issue draft body to the clipboard", async () => {
    exportFindingIssueDraft.mockResolvedValue({ title: "T", body: "BODY_MD", labels: [] });
    renderDialog();
    const btn = await screen.findByTestId("deep-dive-copy");
    fireEvent.click(btn);
    await waitFor(() => expect(exportFindingIssueDraft).toHaveBeenCalled());
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("BODY_MD"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it("surfaces an inline error when the export request fails", async () => {
    exportFindingIssueDraftMarkdown.mockRejectedValue(new Error("boom"));
    renderDialog();
    const btn = await screen.findByTestId("deep-dive-export-md");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("deep-dive-error")).toBeInTheDocument());
  });
});
