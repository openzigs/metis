/**
 * Issue #1006 — an analysis can start from imported requirements, and the run
 * shows which imported item each requirement came from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportedRequirementOptions } from "@metis/shared";

const importedRequirements = vi.fn(async (_path?: string): Promise<ImportedRequirementOptions> =>
  options([]),
);
const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  streamFetch: vi.fn(),
}));

import { ImportedRequirementsPicker } from "@/components/analysis/imported-requirements-picker";
import { SourceRequirementsPanel } from "@/components/analysis/source-requirements-panel";
import { analysisApi } from "@/lib/analysis-api";

const item = (n: number, title: string) => ({
  id: `req-${n}`,
  title,
  type: "feature",
  externalSource: "github",
  externalId: String(n),
  externalUrl: `https://github.com/miniflux/v2/issues/${n}`,
});

/** A listing response; `total` defaults to the rows returned (not cut). */
function options(
  items: ImportedRequirementOptions["items"],
  maxSelectable = 8,
  total = items.length,
): ImportedRequirementOptions {
  return { items, maxSelectable, total, truncated: total > items.length };
}

function renderPicker(selected: string[], onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ImportedRequirementsPicker projectId="proj-1" selected={selected} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  mockApiFetch.mockReset();
  importedRequirements.mockReset();
  mockApiFetch.mockImplementation(async (path: string) =>
    path.includes("/imported-requirements") ? importedRequirements(path) : undefined,
  );
});
afterEach(cleanup);

describe("ImportedRequirementsPicker (#1006)", () => {
  it("renders nothing when the project has no imported requirements", async () => {
    importedRequirements.mockResolvedValue(options([], 8));
    renderPicker([]);
    await vi.waitFor(() => expect(importedRequirements).toHaveBeenCalled());
    expect(screen.queryByTestId("imported-requirements-picker")).not.toBeInTheDocument();
  });

  it("lists imported items and adds a picked one to the selection", async () => {
    importedRequirements.mockResolvedValue(
      options([item(3401, "Mark all as read"), item(3402, "Star shortcut")], 8),
    );
    const onChange = renderPicker(["req-3402"]);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Mark all as read/ }));
    expect(onChange).toHaveBeenCalledWith(["req-3402", "req-3401"]);
    expect(screen.getByText(/GitHub #3401/)).toBeInTheDocument();
  });

  it("removes an item that is unticked", async () => {
    importedRequirements.mockResolvedValue(options([item(1, "A")], 8));
    const onChange = renderPicker(["req-1"]);
    fireEvent.click(await screen.findByRole("checkbox", { name: /^A/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("stops further picks at the server's per-run cap", async () => {
    importedRequirements.mockResolvedValue(options([item(1, "A"), item(2, "B")], 1));
    renderPicker(["req-1"]);
    expect(await screen.findByRole("checkbox", { name: /^B/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /^A/ })).toBeEnabled();
  });

  it("filters the list by title", async () => {
    importedRequirements.mockResolvedValue(
      options([item(1, "Mark all as read"), item(2, "Star shortcut")], 8),
    );
    renderPicker([]);
    await screen.findByRole("checkbox", { name: /Star shortcut/ });
    fireEvent.change(screen.getByLabelText("Filter imported requirements"), {
      target: { value: "star" },
    });
    expect(screen.queryByRole("checkbox", { name: /Mark all as read/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Star shortcut/ })).toBeInTheDocument();
  });

  it("says when the server cut the list, and searches the server for an older item", async () => {
    importedRequirements.mockImplementation(async (path?: string) =>
      path?.includes("?q=")
        ? options([item(12, "Old OPML export")])
        : options([item(1, "Mark all as read")], 8, 600),
    );
    renderPicker([]);
    expect(await screen.findByTestId("imported-requirements-truncated")).toHaveTextContent(
      "Showing the newest 1 of 600; refine the filter",
    );
    fireEvent.change(screen.getByLabelText("Filter imported requirements"), {
      target: { value: "#12" },
    });
    expect(
      await screen.findByRole("checkbox", { name: /Old OPML export/ }, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(importedRequirements).toHaveBeenLastCalledWith(
      "/projects/proj-1/analyses/imported-requirements?q=12",
    );
    expect(screen.queryByTestId("imported-requirements-truncated")).not.toBeInTheDocument();
  });

  it("keeps the search box when a search matches nothing", async () => {
    importedRequirements.mockImplementation(async (path?: string) =>
      path?.includes("?q=") ? options([]) : options([item(1, "Mark all as read")]),
    );
    renderPicker([]);
    fireEvent.change(await screen.findByLabelText("Filter imported requirements"), {
      target: { value: "nothing" },
    });
    expect(
      await screen.findByText(/No imported requirements match/, undefined, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Filter imported requirements")).toBeInTheDocument();
  });
});

describe("SourceRequirementsPanel (#1006)", () => {
  const link = {
    candidateId: "NR-1",
    requirementId: "req-3401",
    title: "Mark all as read",
    externalSource: "github",
    externalId: "3401",
    externalUrl: "https://github.com/miniflux/v2/issues/3401",
  };

  it("links each NR id back to its imported item", () => {
    render(<SourceRequirementsPanel sourceRequirements={[link]} />);
    const row = screen.getByTestId("source-requirement-NR-1");
    expect(row).toHaveTextContent("NR-1 Mark all as read");
    expect(screen.getByRole("link", { name: "github #3401" })).toHaveAttribute(
      "href",
      link.externalUrl,
    );
  });

  it("never renders a non-http URL as a link", () => {
    render(
      <SourceRequirementsPanel
        sourceRequirements={[{ ...link, externalUrl: "javascript:alert(1)" }]}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("github #3401")).toBeInTheDocument();
  });

  it("renders nothing for a run not started from imported requirements", () => {
    const { container } = render(<SourceRequirementsPanel sourceRequirements={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("analysisApi (#1006)", () => {
  it("reads the project's imported requirements", async () => {
    await analysisApi.importedRequirements("proj-1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj-1/analyses/imported-requirements");
  });

  it("sends a search term as an encoded ?q=", async () => {
    await analysisApi.importedRequirements("proj-1", "a&b");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/proj-1/analyses/imported-requirements?q=a%26b",
    );
  });

  it("maps a snapshot without sourceRequirements to an empty list", async () => {
    mockApiFetch.mockResolvedValue({ id: "an-1", agents: [] });
    expect((await analysisApi.get("an-1")).sourceRequirements).toEqual([]);
  });
});
