/**
 * TraceabilityView tests — Epic #207 (#229).
 *
 * Covers loading, error, empty, and the assembled requirement→spec→code render
 * against a mocked traceability API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementTraceabilityChain } from "@metis/shared";

const { traceabilityApi } = vi.hoisted(() => ({
  traceabilityApi: { chain: vi.fn() },
}));

vi.mock("@/lib/traceability-api", () => ({ traceabilityApi }));

import { TraceabilityView } from "@/components/traceability/traceability-view";

function chain(over: Partial<RequirementTraceabilityChain> = {}): RequirementTraceabilityChain {
  return {
    requirementId: "req-1",
    requirementTitle: "User can log in",
    projectId: "proj-1",
    specs: [],
    directCode: [],
    ...over,
  };
}

function renderView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TraceabilityView projectId="proj-1" requirementId="req-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TraceabilityView", () => {
  it("shows a loading state first", () => {
    traceabilityApi.chain.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("renders specs with their code and the direct code spine", async () => {
    traceabilityApi.chain.mockResolvedValue(
      chain({
        specs: [
          {
            specDocumentId: "spec-1",
            specTitle: "Auth Spec",
            confidence: 0.9,
            source: "derived",
            code: [
              {
                codeSymbolId: "sym-1",
                filePath: "src/auth.ts",
                startLine: 10,
                endLine: 20,
                confidence: 0.8,
                source: "derived",
              },
            ],
          },
        ],
        directCode: [
          {
            codeSymbolId: null,
            filePath: "src/login.ts",
            startLine: 5,
            endLine: 5,
            confidence: 0.3,
            source: "semantic",
          },
        ],
      }),
    );
    renderView();

    expect(await screen.findByText("User can log in")).toBeInTheDocument();
    const spec = await screen.findByTestId("traceability-spec");
    expect(within(spec).getByText("Auth Spec")).toBeInTheDocument();
    expect(within(spec).getByText("src/auth.ts:10-20")).toBeInTheDocument();
    expect(within(spec).getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("src/login.ts:5")).toBeInTheDocument();
  });

  it("renders the empty state when nothing is linked", async () => {
    traceabilityApi.chain.mockResolvedValue(chain());
    renderView();
    expect(await screen.findByTestId("traceability-empty")).toBeInTheDocument();
  });

  it("renders an untitled-spec fallback", async () => {
    traceabilityApi.chain.mockResolvedValue(
      chain({
        specs: [
          { specDocumentId: "s", specTitle: null, confidence: 0.5, source: "manual", code: [] },
        ],
      }),
    );
    renderView();
    expect(await screen.findByText("(untitled spec)")).toBeInTheDocument();
    expect(screen.getByText(/No code linked to this spec yet/)).toBeInTheDocument();
  });

  it("renders an error state", async () => {
    traceabilityApi.chain.mockRejectedValue(new Error("nope"));
    renderView();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
