import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { ArtifactsSection } from "@/components/library/artifacts-section";
import { analysisApi } from "@/lib/analysis-api";

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    listForProject: vi.fn(),
    get: vi.fn(),
  },
}));

const listMock = vi.mocked(analysisApi.listForProject);
const getMock = vi.mocked(analysisApi.get);

const baseAnalysis = {
  id: "an-1",
  projectId: "p-1",
  startedById: "u-1",
  status: "completed" as const,
  startedAt: "2025-01-01T00:00:00Z",
  completedAt: "2025-01-01T01:00:00Z",
  totalTokens: 0,
  errorMessage: null,
  agentResults: [],
  scope: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [baseAnalysis] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderWith(projectId: string | null) {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ArtifactsSection projectId={projectId} />
    </Wrapper>,
  );
}

describe("<ArtifactsSection />", () => {
  it("shows the empty-project state when projectId is null", () => {
    renderWith(null);
    expect(screen.getByTestId("artifacts-empty")).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("renders the artifact list", async () => {
    renderWith("p-1");
    await waitFor(() => expect(screen.getByText(/Analysis an-1/)).toBeInTheDocument());
    expect(screen.getByTestId(`artifact-download-${baseAnalysis.id}`)).toBeEnabled();
  });

  it("disables the download button for non-completed analyses", async () => {
    listMock.mockResolvedValue({
      items: [{ ...baseAnalysis, id: "an-2", status: "running" as const, completedAt: null }],
    });
    renderWith("p-1");
    await waitFor(() => expect(screen.getByTestId("artifact-download-an-2")).toBeDisabled());
  });

  it("shows the empty-list state when no analyses exist", async () => {
    listMock.mockResolvedValue({ items: [] });
    renderWith("p-1");
    await waitFor(() => expect(screen.getByText(/No analyses yet/)).toBeInTheDocument());
  });

  it("triggers a JSON download on click", async () => {
    const snapshot = { ...baseAnalysis, requirements: [], findings: [] };
    getMock.mockResolvedValue(snapshot as unknown as Awaited<ReturnType<typeof analysisApi.get>>);

    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true });

    renderWith("p-1");
    const button = await screen.findByTestId(`artifact-download-${baseAnalysis.id}`);
    fireEvent.click(button);
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(baseAnalysis.id));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
});
