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
    testedBy: [],
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
                isTest: false,
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
            isTest: false,
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

// ---- #816 — "Tested by" ----------------------------------------------------

const CODE = {
  codeSymbolId: "sym-v",
  filePath: "internal/validator/user.go",
  startLine: 12,
  endLine: 40,
  confidence: 0.9,
  source: "derived" as const,
  isTest: false,
};

describe("TraceabilityView — Tested by (#816)", () => {
  it("lists each test as file:line › name with a text relation badge", async () => {
    traceabilityApi.chain.mockResolvedValue(
      chain({
        directCode: [CODE],
        testedBy: [
          {
            codeSymbolId: "t-1",
            filePath: "internal/validator/user_test.go",
            symbol: "internal/validator/user_test.go::TestValidatePassword",
            name: "TestValidatePassword",
            startLine: 18,
            convention: "go-testing",
            relation: "exercises",
            subject: { filePath: CODE.filePath, symbol: "ValidatePassword" },
            score: 0.8,
          },
          {
            codeSymbolId: null,
            filePath: "internal/validator/password_test.go",
            symbol: "internal/validator/password_test.go",
            name: "password_test.go",
            startLine: null,
            convention: "go-testing",
            relation: "direct",
            subject: null,
            score: 1,
          },
          {
            codeSymbolId: "t-3",
            filePath: "internal/validator/user_test.go",
            symbol: "internal/validator/user_test.go::TestUser",
            name: "TestUser",
            startLine: 50,
            convention: "go-testing",
            relation: "naming",
            subject: { filePath: CODE.filePath, symbol: null },
            score: 0.4,
          },
        ],
      }),
    );
    renderView();

    const section = await screen.findByRole("region", { name: /^Tested by/ });
    const rows = within(section).getAllByTestId("traceability-test-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("internal/validator/user_test.go:18");
    expect(rows[0]).toHaveTextContent("TestValidatePassword");
    expect(within(rows[0]).getByText("Calls the code")).toBeInTheDocument();
    // A file-only hit has no line: the location is the bare path.
    expect(within(rows[1]).getByText("internal/validator/password_test.go")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Mapped directly")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Naming convention")).toBeInTheDocument();
    expect(within(section).getByRole("heading", { name: "Tested by (3)" })).toBeInTheDocument();
    expect(screen.queryByTestId("traceability-no-test")).toBeNull();
    expect(screen.queryByTestId("traceability-no-code")).toBeNull();
  });

  it("says 'No linked test' when code is mapped but no test resolves", async () => {
    traceabilityApi.chain.mockResolvedValue(chain({ directCode: [CODE] }));
    renderView();
    expect(await screen.findByTestId("traceability-no-test")).toHaveTextContent("No linked test");
    expect(screen.queryByTestId("traceability-no-code")).toBeNull();
  });

  it("counts code reached through a spec as mapped code", async () => {
    traceabilityApi.chain.mockResolvedValue(
      chain({
        specs: [
          {
            specDocumentId: "s",
            specTitle: "Spec",
            confidence: 0.5,
            source: "manual",
            code: [CODE],
          },
        ],
      }),
    );
    renderView();
    expect(await screen.findByTestId("traceability-no-test")).toBeInTheDocument();
  });

  it("says tests can't be linked when no code is mapped", async () => {
    traceabilityApi.chain.mockResolvedValue(chain());
    renderView();
    expect(await screen.findByTestId("traceability-no-code")).toHaveTextContent(
      "No code mapped yet, so tests can't be linked",
    );
    expect(screen.queryByTestId("traceability-no-test")).toBeNull();
  });

  it("badges mapped code that is itself a test", async () => {
    traceabilityApi.chain.mockResolvedValue(
      chain({
        directCode: [
          CODE,
          {
            ...CODE,
            codeSymbolId: "sym-t",
            filePath: "internal/validator/user_test.go",
            isTest: true,
          },
        ],
      }),
    );
    renderView();
    const rows = await screen.findAllByTestId("traceability-code-row");
    expect(within(rows[0]).queryByText("test")).toBeNull();
    expect(within(rows[1]).getByText("test")).toBeInTheDocument();
  });
});
