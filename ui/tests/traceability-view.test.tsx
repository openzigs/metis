/**
 * Component tests for <TraceabilityView /> (branch feat/req-code-traceability).
 *
 * Asserts that once the chain carries directCode entries (the rows now
 * auto-seeded server-side from analysis grounding), the panel renders the code
 * rows instead of the "No specs or code are linked" empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementTraceabilityChain } from "@metis/shared";

const chainMock = vi.fn();
vi.mock("@/lib/traceability-api", () => ({
  traceabilityApi: {
    chain: (...args: unknown[]) => chainMock(...args),
  },
}));

import { TraceabilityView } from "@/components/traceability/traceability-view";

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TraceabilityView projectId="proj-1" requirementId="req-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TraceabilityView />", () => {
  it("renders direct code rows (not the empty state) when directCode is populated", async () => {
    const chain: RequirementTraceabilityChain = {
      requirementId: "req-1",
      requirementTitle: "Audit logging",
      projectId: "proj-1",
      specs: [],
      directCode: [
        {
          codeSymbolId: null,
          filePath: "src/auth.ts",
          startLine: null,
          endLine: null,
          confidence: 0.5,
          source: "analysis-grounding",
        },
      ],
    };
    chainMock.mockResolvedValue(chain);

    renderView();

    await waitFor(() => {
      expect(screen.getByText(/Direct code links \(1\)/)).toBeInTheDocument();
    });
    expect(screen.getByTestId("traceability-code-row")).toHaveTextContent("src/auth.ts");
    expect(screen.queryByTestId("traceability-empty")).not.toBeInTheDocument();
  });

  it("renders the empty state when there are no specs or code", async () => {
    const chain: RequirementTraceabilityChain = {
      requirementId: "req-1",
      requirementTitle: "Audit logging",
      projectId: "proj-1",
      specs: [],
      directCode: [],
    };
    chainMock.mockResolvedValue(chain);

    renderView();

    await waitFor(() => {
      expect(screen.getByTestId("traceability-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("traceability-code-row")).not.toBeInTheDocument();
  });
});
