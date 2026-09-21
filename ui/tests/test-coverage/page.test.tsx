/**
 * Tests for the Test Coverage page (Epic #856 issue #865).
 *
 * The page is heavy on async state — these tests focus on the static
 * structure, empty states, and the export low-confidence override path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
}));

const { socketStub, api, downloadBlob } = vi.hoisted(() => ({
  socketStub: { on: vi.fn(), off: vi.fn() },
  api: {
    listImports: vi.fn(),
    uploadImport: vi.fn(),
    pasteImport: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    createRun: vi.fn(),
    getReport: vi.fn(),
    getBudget: vi.fn(),
    overrideMapping: vi.fn(),
    updateSuggestion: vi.fn(),
    exportRun: vi.fn(),
    pullFromConnector: vi.fn(),
  },
  downloadBlob: vi.fn(),
}));

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => socketStub,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
    };
  },
}));

vi.mock("@/lib/test-coverage-api", () => ({
  testCoverageApi: api,
  downloadBlob,
}));

import TestCoveragePage from "@/app/(authed)/projects/[id]/test-coverage/page";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TestCoveragePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  socketStub.on.mockReset();
  socketStub.off.mockReset();
  downloadBlob.mockReset();

  api.listImports.mockResolvedValue([]);
  api.listRuns.mockResolvedValue([]);
});

describe("TestCoveragePage", () => {
  it("renders empty states when there are no imports or runs", async () => {
    renderPage();
    expect(await screen.findByTestId("test-coverage-page")).toBeInTheDocument();
    expect(await screen.findByTestId("tc-imports-empty")).toBeInTheDocument();
    expect(await screen.findByTestId("tc-runs-empty")).toBeInTheDocument();
  });

  it("kicks off a new run when the button is clicked", async () => {
    const user = userEvent.setup();
    api.createRun.mockResolvedValue({
      id: "run-1",
      projectId: "p1",
      status: "queued",
      triggeredById: null,
      modelTag: null,
      createdAt: new Date().toISOString(),
    });
    renderPage();
    await user.click(await screen.findByTestId("tc-new-run-button"));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledWith("p1", {}));
  });

  it("renders the summary, matrix, gaps and suggestions when a run completes", async () => {
    const now = new Date().toISOString();
    api.listRuns.mockResolvedValue([
      {
        id: "run-1",
        projectId: "p1",
        status: "succeeded",
        triggeredById: null,
        modelTag: null,
        createdAt: now,
      },
    ]);
    api.getReport.mockResolvedValue({
      run: {
        id: "run-1",
        projectId: "p1",
        status: "succeeded",
        triggeredById: null,
        modelTag: null,
        createdAt: now,
      },
      mappings: [
        {
          id: "m1",
          runId: "run-1",
          requirementId: "r1",
          testCaseDocId: "t1",
          cosine: 0.9,
          bm25: 0.7,
          fused: 0.85,
          judgeConfidence: 0.9,
          status: "COVERED",
          overriddenById: null,
          overrideReason: null,
        },
      ],
      gaps: [{ id: "g1", runId: "run-1", requirementId: "r2", severity: "high", meta: "{}" }],
      suggestions: [
        {
          id: "s1",
          runId: "run-1",
          title: "Suggested test",
          mappedRequirementIds: '["r2"]',
          gwtJson: '{"given":["g"],"when":["w"],"then":["t"]}',
          stepsJson: "[]",
          faithfulness: 0.7,
          lowConfidence: true,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 2, covered: 1, gaps: 1, suggestions: 1, coveragePct: 42.5 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 25,
      limitCents: 100,
      remainingCents: 75,
    });

    renderPage();

    await waitFor(() => expect(screen.getByTestId("tc-coverage-pct")).toHaveTextContent("42.5%"));
    expect(screen.getByTestId("tc-matrix-card")).toBeInTheDocument();
    expect(screen.getByTestId("tc-gaps-card")).toBeInTheDocument();
    expect(screen.getByTestId("tc-suggestions-card")).toBeInTheDocument();
    expect(screen.getByTestId("tc-low-conf-badge")).toBeInTheDocument();
  });

  it("subscribes to socket run lifecycle events", async () => {
    renderPage();
    await waitFor(() => expect(socketStub.on).toHaveBeenCalled());
    const events = socketStub.on.mock.calls.map((c) => c[0]);
    expect(events).toContain("testcoverage:run-update");
    expect(events).toContain("testcoverage:run-finished");
  });

  it("uploads a file via the file input", async () => {
    const user = userEvent.setup();
    api.uploadImport.mockResolvedValue({
      id: "imp-1",
      source: "csv",
      filename: "cases.csv",
      byteSize: 10,
      createdById: null,
      createdAt: new Date().toISOString(),
      casesParsed: 2,
      casesUpserted: 2,
    });
    renderPage();
    const input = await screen.findByTestId("tc-upload-input");
    const file = new File(["a,b\n1,2"], "cases.csv", { type: "text/csv" });
    await user.upload(input, file);
    await waitFor(() => expect(api.uploadImport).toHaveBeenCalledWith("p1", file));
  });

  it("submits a paste import from the dialog", async () => {
    const user = userEvent.setup();
    api.pasteImport.mockResolvedValue({
      id: "imp-2",
      source: "csv",
      filename: null,
      byteSize: 10,
      createdById: null,
      createdAt: new Date().toISOString(),
      casesParsed: 1,
      casesUpserted: 1,
    });
    renderPage();
    await user.click(await screen.findByTestId("tc-paste-button"));
    const ta = await screen.findByTestId("tc-paste-textarea");
    await user.type(ta, "title\nLogin");
    await user.click(screen.getByTestId("tc-paste-submit"));
    await waitFor(() =>
      expect(api.pasteImport).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ source: "csv", text: "title\nLogin" }),
      ),
    );
  });

  it("accepts a suggestion when the Accept button is clicked", async () => {
    const now = new Date().toISOString();
    const run = {
      id: "run-1",
      projectId: "p1",
      status: "succeeded",
      triggeredById: null,
      modelTag: null,
      createdAt: now,
    };
    api.listRuns.mockResolvedValue([run]);
    api.getReport.mockResolvedValue({
      run,
      mappings: [],
      gaps: [],
      suggestions: [
        {
          id: "s1",
          runId: "run-1",
          title: "T",
          mappedRequirementIds: "[]",
          gwtJson: '{"given":[],"when":[],"then":[]}',
          stepsJson: "[]",
          faithfulness: 0.9,
          lowConfidence: false,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
    });
    api.updateSuggestion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    const accept = await screen.findByRole("button", { name: /^accept$/i });
    await user.click(accept);
    await waitFor(() =>
      expect(api.updateSuggestion).toHaveBeenCalledWith("p1", "s1", {
        status: "accepted",
      }),
    );
  });

  it("exports a run and triggers a download", async () => {
    const now = new Date().toISOString();
    const run = {
      id: "run-1",
      projectId: "p1",
      status: "succeeded",
      triggeredById: null,
      modelTag: null,
      createdAt: now,
    };
    api.listRuns.mockResolvedValue([run]);
    api.getReport.mockResolvedValue({
      run,
      mappings: [],
      gaps: [],
      suggestions: [
        {
          id: "sx",
          runId: "run-1",
          title: "Tx",
          mappedRequirementIds: "[]",
          gwtJson: '{"given":[],"when":[],"then":[]}',
          stepsJson: "[]",
          faithfulness: 0.9,
          lowConfidence: false,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
    });
    api.exportRun.mockResolvedValue({
      kind: "file",
      blob: new Blob(["x"]),
      filename: "coverage.xlsx",
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tc-export-button"));
    await user.click(await screen.findByTestId("tc-export-override"));
    await user.click(screen.getByTestId("tc-export-submit"));
    await waitFor(() =>
      expect(api.exportRun).toHaveBeenCalledWith("p1", {
        runId: "run-1",
        target: "excel",
        overrideLowConfidence: true,
      }),
    );
    expect(downloadBlob).toHaveBeenCalled();
  });

  it("opens the review drawer and renders Given/When/Then", async () => {
    const now = new Date().toISOString();
    const run = {
      id: "run-1",
      projectId: "p1",
      status: "succeeded",
      triggeredById: null,
      modelTag: null,
      createdAt: now,
    };
    api.listRuns.mockResolvedValue([run]);
    api.getReport.mockResolvedValue({
      run,
      mappings: [],
      gaps: [],
      suggestions: [
        {
          id: "s9",
          runId: "run-1",
          title: "Login flow",
          mappedRequirementIds: '["r1"]',
          gwtJson: '{"given":["user exists"],"when":["submit form"],"then":["dashboard shown"]}',
          stepsJson: "[]",
          faithfulness: 0.55,
          lowConfidence: true,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
    });
    api.updateSuggestion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /review/i }));
    expect(await screen.findByText(/user exists/i)).toBeInTheDocument();
    expect(screen.getByText(/submit form/i)).toBeInTheDocument();
    expect(screen.getByText(/dashboard shown/i)).toBeInTheDocument();
    // Drawer also has Accept / Reject buttons that fire mutations.
    const drawerReject = screen.getAllByRole("button", { name: /^reject$/i }).pop()!;
    await user.click(drawerReject);
    await waitFor(() =>
      expect(api.updateSuggestion).toHaveBeenCalledWith("p1", "s9", {
        status: "rejected",
      }),
    );
  });

  it("rejects a suggestion via the row's Reject button", async () => {
    const now = new Date().toISOString();
    const run = {
      id: "run-1",
      projectId: "p1",
      status: "succeeded",
      triggeredById: null,
      modelTag: null,
      createdAt: now,
    };
    api.listRuns.mockResolvedValue([run]);
    api.getReport.mockResolvedValue({
      run,
      mappings: [],
      gaps: [],
      suggestions: [
        {
          id: "row1",
          runId: "run-1",
          title: "RowTitle",
          mappedRequirementIds: "[]",
          gwtJson: '{"given":[],"when":[],"then":[]}',
          stepsJson: "[]",
          faithfulness: 0.9,
          lowConfidence: false,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
    });
    api.updateSuggestion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^reject$/i }));
    await waitFor(() =>
      expect(api.updateSuggestion).toHaveBeenCalledWith("p1", "row1", {
        status: "rejected",
      }),
    );
  });

  it("accepts a suggestion from inside the review drawer and surfaces low-confidence warning", async () => {
    const now = new Date().toISOString();
    const run = {
      id: "run-1",
      projectId: "p1",
      status: "succeeded",
      triggeredById: null,
      modelTag: null,
      createdAt: now,
    };
    api.listRuns.mockResolvedValue([run]);
    api.getReport.mockResolvedValue({
      run,
      mappings: [],
      gaps: [],
      suggestions: [
        {
          id: "sd",
          runId: "run-1",
          title: "Drawer flow",
          mappedRequirementIds: '["r1"]',
          gwtJson: '{"given":["G"],"when":["W"],"then":["T"]}',
          stepsJson: "[]",
          faithfulness: 0.4,
          lowConfidence: true,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
    });
    api.updateSuggestion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /review/i }));
    expect(await screen.findByText(/Low-confidence/i)).toBeInTheDocument();
    const drawerAccept = screen.getAllByRole("button", { name: /^accept$/i }).pop()!;
    await user.click(drawerAccept);
    await waitFor(() =>
      expect(api.updateSuggestion).toHaveBeenCalledWith("p1", "sd", {
        status: "accepted",
      }),
    );
  });

  it("surfaces export errors in the dialog", async () => {
    const now = new Date().toISOString();
    const run = {
      id: "run-1",
      projectId: "p1",
      status: "succeeded",
      triggeredById: null,
      modelTag: null,
      createdAt: now,
    };
    api.listRuns.mockResolvedValue([run]);
    api.getReport.mockResolvedValue({
      run,
      mappings: [],
      gaps: [],
      suggestions: [
        {
          id: "se",
          runId: "run-1",
          title: "T",
          mappedRequirementIds: "[]",
          gwtJson: '{"given":[],"when":[],"then":[]}',
          stepsJson: "[]",
          faithfulness: 0.9,
          lowConfidence: false,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
    });
    api.exportRun.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tc-export-button"));
    await user.click(screen.getByTestId("tc-export-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/);
  });

  it("renders budget without NaN when limitCents is zero", async () => {
    const now = new Date().toISOString();
    api.listRuns.mockResolvedValue([
      {
        id: "run-1",
        projectId: "p1",
        status: "succeeded",
        triggeredById: null,
        modelTag: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    api.getReport.mockResolvedValue({
      runId: "run-1",
      requirements: [],
      testCases: [],
      mappings: [],
      gaps: [],
      suggestions: [],
      summary: { total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: 0 },
    });
    api.getBudget.mockResolvedValue({
      usedCents: 0,
      limitCents: 0,
      remainingCents: 0,
    });
    renderPage();
    const line = await screen.findByTestId("tc-budget-line");
    expect(line.textContent ?? "").not.toMatch(/NaN/);
    expect(line.textContent ?? "").toMatch(/0% used/);
  });

  it("submits a connector pull from the picker", async () => {
    api.pullFromConnector.mockResolvedValue({
      id: "imp-conn-1",
      source: "jira",
      label: "Jira PROJ",
      casesParsed: 5,
      casesUpserted: 5,
    });
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByTestId("tc-connector-source"), "jira");
    await user.type(screen.getByTestId("tc-connector-baseUrl"), "https://example.atlassian.net");
    await user.type(screen.getByTestId("tc-connector-username"), "user@example.com");
    await user.type(screen.getByTestId("tc-connector-apiToken"), "token-abc");
    await user.type(screen.getByTestId("tc-connector-projectKey"), "PROJ");
    await user.click(screen.getByTestId("tc-connector-pull"));

    await waitFor(() =>
      expect(api.pullFromConnector).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          source: "jira",
          baseUrl: "https://example.atlassian.net",
          username: "user@example.com",
          apiToken: "token-abc",
          projectKey: "PROJ",
        }),
      ),
    );
    expect(await screen.findByTestId("tc-connector-success")).toHaveTextContent(/Imported 5 cases/);
  });

  // WCAG 2.1 SC 1.3.5 Identify Input Purpose (#659). The connector picker
  // renders the same user-identity credentials as the connections page (the
  // Jira login username and the TestRail login email), so they must carry the
  // matching H98 purpose token — consistently with the connections surface.
  // Sibling secret fields (API token, API key) hold service credentials, not
  // the user's identity, and must OMIT autocomplete so a browser never
  // autofills identity data into a secret.
  it("tags user-identity connector fields with the H98 token and omits it on secrets", async () => {
    const user = userEvent.setup();
    renderPage();

    // Jira: username is the person's Atlassian login → `username`.
    await user.selectOptions(await screen.findByTestId("tc-connector-source"), "jira");
    expect(screen.getByTestId("tc-connector-username")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByTestId("tc-connector-apiToken")).not.toHaveAttribute("autocomplete");
    expect(screen.getByTestId("tc-connector-baseUrl")).not.toHaveAttribute("autocomplete");

    // TestRail: email is the person's login email → `email`.
    await user.selectOptions(screen.getByTestId("tc-connector-source"), "testrail");
    expect(screen.getByTestId("tc-connector-email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByTestId("tc-connector-apiKey")).not.toHaveAttribute("autocomplete");
  });
});
