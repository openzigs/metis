import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import { ApiError } from "@/lib/api-client";

const push = vi.fn();
let search = new URLSearchParams();

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push }),
    usePathname: () => "/impact-analyses/new",
    useSearchParams: () => search,
  };
});

const mutate = vi.fn(
  (
    _payload: unknown,
    opts?: { onSuccess?: (r: { id: string; status: string; projectIds: string[] }) => void },
  ) => {
    opts?.onSuccess?.({ id: "ia-new-0001", status: "pending", projectIds: [] });
  },
);

let mutationState: { mutate: typeof mutate; isPending: boolean; error: unknown };

vi.mock("@/lib/impact-analysis-hooks", () => ({
  useCreateImpactAnalysis: () => mutationState,
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue({ items: [{ id: "project-001", name: "Alpha" }] }),
  },
  documentsApi: {
    list: vi.fn().mockResolvedValue({ items: [{ id: "doc-0000001", filename: "spec.docx" }] }),
  },
}));

const getAnalysis = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", () => ({ analysisApi: { get: getAnalysis } }));

import NewImpactAnalysisPage from "@/app/(authed)/impact-analyses/new/page";
import { documentsApi } from "@/lib/projects-api";

/** #2351 — the projects are ticked in the shared scope picker's popover. */
async function openScope() {
  fireEvent.click(screen.getByTestId("impact-scope-selector"));
  await screen.findByLabelText("Alpha");
}

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
  mutationState = { mutate, isPending: false, error: null };
});

describe("NewImpactAnalysisPage", () => {
  // #28 — the project's Analyze → Impact Analysis entry links here with
  // `?projectId=`, which must arrive with that project already selected.
  it("pre-selects the project named in ?projectId", async () => {
    search = new URLSearchParams("projectId=project-001");
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("multi-project-count")).toHaveTextContent("1 selected");
    // #2351 — the shared picker starts on "This project".
    await waitFor(() =>
      expect(screen.getByTestId("impact-scope-selector")).toHaveTextContent("This project: Alpha"),
    );
  });

  it("shows a contrast pointer to the per-project Requirements Analysis tab", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    expect(
      screen.getByText(
        /To synthesize requirements for a single project, use that project's Requirements Analysis tab\./i,
      ),
    ).toBeInTheDocument();
  });

  it("disables submit until a project and source are provided", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("run-impact-analysis")).toBeDisabled();
    expect(screen.getByTestId("impact-new-hint")).toBeInTheDocument();
  });

  it("enables the run control with exactly one project selected", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.change(screen.getByTestId("source-text-input"), {
      target: { value: "Add SSO login" },
    });
    expect(screen.getByTestId("multi-project-count")).toHaveTextContent("1 selected");
    expect(screen.getByTestId("run-impact-analysis")).toBeEnabled();
    expect(screen.queryByTestId("impact-new-hint")).not.toBeInTheDocument();
  });

  it("submits pasted text and navigates to the new analysis", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.change(screen.getByTestId("source-text-input"), {
      target: { value: "Add SSO login" },
    });
    fireEvent.click(screen.getByTestId("run-impact-analysis"));
    expect(mutate).toHaveBeenCalledWith(
      { text: "Add SSO login", projectIds: ["project-001"] },
      expect.any(Object),
    );
    expect(push).toHaveBeenCalledWith("/impact-analyses/ia-new-0001");
  });

  it("opts out of schema impact when the toggle is unchecked", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.change(screen.getByTestId("source-text-input"), {
      target: { value: "Add SSO login" },
    });
    fireEvent.click(screen.getByTestId("impact-new-schema-checkbox"));
    fireEvent.click(screen.getByTestId("run-impact-analysis"));
    expect(mutate).toHaveBeenCalledWith(
      { text: "Add SSO login", projectIds: ["project-001"], includeSchemaImpact: false },
      expect.any(Object),
    );
  });

  it("opts into downstream dependencies when the deps toggle is checked", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.change(screen.getByTestId("source-text-input"), {
      target: { value: "Add SSO login" },
    });
    fireEvent.click(screen.getByTestId("impact-new-deps-checkbox"));
    fireEvent.click(screen.getByTestId("run-impact-analysis"));
    expect(mutate).toHaveBeenCalledWith(
      { text: "Add SSO login", projectIds: ["project-001"], includeDependencies: true },
      expect.any(Object),
    );
  });

  it("submits a selected document", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.click(screen.getByTestId("source-mode-document"));
    await waitFor(() => expect(screen.getByTestId("source-document-select")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("source-document-select"), {
      target: { value: "doc-0000001" },
    });
    fireEvent.click(screen.getByTestId("run-impact-analysis"));
    expect(mutate).toHaveBeenCalledWith(
      { documentId: "doc-0000001", projectIds: ["project-001"] },
      expect.any(Object),
    );
  });

  it("#2280 — offers to read the document again only for a document source, and sends it when ticked", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    expect(screen.queryByTestId("impact-new-reread-checkbox")).toBeNull();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.click(screen.getByTestId("source-mode-document"));
    await waitFor(() => expect(screen.getByTestId("source-document-select")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("source-document-select"), {
      target: { value: "doc-0000001" },
    });
    fireEvent.click(screen.getByTestId("impact-new-reread-checkbox"));
    fireEvent.click(screen.getByTestId("run-impact-analysis"));
    expect(mutate).toHaveBeenCalledWith(
      { documentId: "doc-0000001", projectIds: ["project-001"], rereadDocument: true },
      expect.any(Object),
    );
  });

  it("renders an API error message", async () => {
    mutationState = { mutate, isPending: false, error: new ApiError(400, "bad request") };
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-new-error")).toHaveTextContent("bad request");
  });

  it("renders a generic message for non-ApiError failures", async () => {
    mutationState = { mutate, isPending: false, error: new Error("boom") };
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-new-error")).toHaveTextContent(
      "Failed to start impact analysis.",
    );
  });

  it("shows a loading state while documents are fetching", async () => {
    vi.mocked(documentsApi.list).mockReturnValueOnce(new Promise(() => {}));
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await openScope();
    fireEvent.click(await screen.findByLabelText("Alpha"));
    fireEvent.click(screen.getByTestId("source-mode-document"));
    await waitFor(() => expect(screen.getByTestId("source-documents-loading")).toBeInTheDocument());
  });

  describe("#2345 — from a change request", () => {
    beforeEach(() => {
      getAnalysis.mockResolvedValue({
        id: "an-0000001",
        projectId: "project-001",
        title: "Password reset",
        requirements: [
          { id: "r1", reviewStatus: "draft" },
          { id: "r2", reviewStatus: "approved" },
          { id: "r3", reviewStatus: "rejected" },
        ],
      });
    });

    it("names the change request as the source, sends it instead of text, and links back to it", async () => {
      search = new URLSearchParams("projectId=project-001&analysisId=an-0000001");
      render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
      const source = await screen.findByTestId("impact-new-change-request");
      await waitFor(() => expect(source).toHaveTextContent("Password reset"));
      expect(source).toHaveTextContent("Its 2 draft and approved requirements are analysed");
      expect(screen.queryByTestId("source-text-input")).toBeNull();
      expect(screen.getByTestId("impact-new-back")).toHaveAttribute(
        "href",
        "/projects/project-001/analysis?analysisId=an-0000001",
      );
      await waitFor(() => expect(screen.getByTestId("run-impact-analysis")).toBeEnabled());
      fireEvent.click(screen.getByTestId("run-impact-analysis"));
      expect(mutate.mock.calls[0][0]).toEqual({
        analysisId: "an-0000001",
        projectIds: ["project-001"],
      });
      expect(getAnalysis).toHaveBeenCalledWith("an-0000001");
    });

    it("says only the first 50 are analysed when the change request has more", async () => {
      getAnalysis.mockResolvedValue({
        id: "an-0000001",
        projectId: "project-001",
        title: "Password reset",
        requirements: Array.from({ length: 51 }, (_, i) => ({
          id: `r${i}`,
          reviewStatus: "draft",
        })),
      });
      search = new URLSearchParams("projectId=project-001&analysisId=an-0000001");
      render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
      const source = await screen.findByTestId("impact-new-change-request");
      await waitFor(() =>
        expect(source).toHaveTextContent(
          "The first 50 of its 51 draft and approved requirements are analysed",
        ),
      );
      expect(source).not.toHaveTextContent("Its 51");
    });

    it("waits while the change request's project is not selected", async () => {
      search = new URLSearchParams("analysisId=an-0000001");
      render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
      await screen.findByText("Password reset");
      await openScope();
      expect(screen.getByTestId("run-impact-analysis")).toBeDisabled();
      expect(screen.getByTestId("impact-new-hint")).toHaveTextContent(
        "Keep the change request's project selected.",
      );
      fireEvent.click(await screen.findByLabelText("Alpha"));
      expect(screen.getByTestId("run-impact-analysis")).toBeEnabled();
    });

    it("can drop the change request and type a source instead", async () => {
      search = new URLSearchParams("projectId=project-001&analysisId=an-0000001");
      render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
      fireEvent.click(
        await screen.findByRole("button", { name: "Use pasted text or a document instead" }),
      );
      fireEvent.change(screen.getByTestId("source-text-input"), {
        target: { value: "Add SSO login" },
      });
      fireEvent.click(screen.getByTestId("run-impact-analysis"));
      expect(mutate.mock.calls[0][0]).toEqual({
        text: "Add SSO login",
        projectIds: ["project-001"],
      });
    });
  });
});
