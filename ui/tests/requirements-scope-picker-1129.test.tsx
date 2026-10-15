/**
 * #1129 — the requirements BRD can be limited to chosen requirements, and the
 * form says how many the document will cover.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis-api")>()),
  analysisApi: { get },
}));

import { RequirementsScopePicker } from "@/components/documentation/requirements-scope-picker";

const imported = [{ candidateId: "NR-1" }];
const REQUIREMENTS = [
  { id: "r1", title: "Mark all read", reviewStatus: "approved", sourceItems: imported },
  { id: "r2", title: "Import OPML", reviewStatus: "approved", sourceItems: [] },
  { id: "r3", title: "Per-feed refresh", reviewStatus: "draft", sourceItems: imported },
];

const seen: Array<ReadonlySet<string> | null> = [];
function Harness({ approvedOnly = false }: { approvedOnly?: boolean }) {
  const [value, setValue] = useState<ReadonlySet<string> | null>(null);
  return (
    <RequirementsScopePicker
      analysisId="run-8"
      approvedOnly={approvedOnly}
      value={value}
      onChange={(next) => {
        seen.push(next);
        setValue(next);
      }}
    />
  );
}

function renderPicker(approvedOnly = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness approvedOnly={approvedOnly} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
  get.mockResolvedValue({ requirements: REQUIREMENTS });
});

describe("RequirementsScopePicker — #1129", () => {
  it("covers the whole run until a requirement is unchosen", async () => {
    renderPicker();
    expect(await screen.findByTestId("requirements-scope-count")).toHaveTextContent(
      "The document will cover 3 of 3 requirements.",
    );
    fireEvent.click(screen.getByLabelText("Import OPML"));
    expect(screen.getByTestId("requirements-scope-count")).toHaveTextContent("cover 2 of 3");
    expect([...(seen.at(-1) ?? [])]).toEqual(["r1", "r3"]);

    // Choosing it back is the whole run again: no requirementIds are sent.
    fireEvent.click(screen.getByLabelText("Import OPML"));
    expect(seen.at(-1)).toBeNull();
  });

  it("keeps only the ticked items in one click, and Choose all restores the run", async () => {
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: "Only the 2 from ticked items" }));
    expect([...(seen.at(-1) ?? [])]).toEqual(["r1", "r3"]);
    expect(screen.getByTestId("requirements-scope-count")).toHaveTextContent("cover 2 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Choose all" }));
    expect(seen.at(-1)).toBeNull();
  });

  it("counts only approved requirements when the document is approved-only", async () => {
    renderPicker(true);
    expect(await screen.findByTestId("requirements-scope-count")).toHaveTextContent(
      "cover 2 of 2 requirements",
    );
    expect(screen.queryByLabelText("Per-feed refresh")).toBeNull();
  });

  it("renders nothing for a run with no requirements", async () => {
    get.mockResolvedValue({ requirements: [] });
    const { container } = renderPicker();
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
