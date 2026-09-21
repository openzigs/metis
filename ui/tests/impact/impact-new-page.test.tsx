import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import { ApiError } from "@/lib/api-client";

const push = vi.fn();

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push }),
    usePathname: () => "/impact-analyses/new",
    useSearchParams: () => new URLSearchParams(),
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

import NewImpactAnalysisPage from "@/app/(authed)/impact-analyses/new/page";
import { documentsApi } from "@/lib/projects-api";

beforeEach(() => {
  vi.clearAllMocks();
  mutationState = { mutate, isPending: false, error: null };
});

describe("NewImpactAnalysisPage", () => {
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
    await waitFor(() =>
      expect(screen.getByTestId("project-checkbox-project-001")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
    fireEvent.change(screen.getByTestId("source-text-input"), {
      target: { value: "Add SSO login" },
    });
    expect(screen.getByTestId("multi-project-count")).toHaveTextContent("1 selected");
    expect(screen.getByTestId("run-impact-analysis")).toBeEnabled();
    expect(screen.queryByTestId("impact-new-hint")).not.toBeInTheDocument();
  });

  it("submits pasted text and navigates to the new analysis", async () => {
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("project-checkbox-project-001")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
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
    await waitFor(() =>
      expect(screen.getByTestId("project-checkbox-project-001")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
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
    await waitFor(() =>
      expect(screen.getByTestId("project-checkbox-project-001")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
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
    await waitFor(() =>
      expect(screen.getByTestId("project-checkbox-project-001")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
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
    await waitFor(() =>
      expect(screen.getByTestId("project-checkbox-project-001")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("project-checkbox-project-001"));
    fireEvent.click(screen.getByTestId("source-mode-document"));
    await waitFor(() => expect(screen.getByTestId("source-documents-loading")).toBeInTheDocument());
  });
});
