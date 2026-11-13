/**
 * Issue #733 — the pre-run capability hint warns which capabilities the run
 * will have, gated by the operator's selected agents, before starting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnalysisCapabilityPreview } from "@metis/shared";

const capabilityPreview = vi.fn(async (): Promise<AnalysisCapabilityPreview> => ({
  codeGraphPresent: false,
  repoSourceIngested: false,
  fusedCodeRetrievalEnabled: false,
  schemaContextEnabled: false,
}));
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    capabilityPreview: () => capabilityPreview(),
  },
}));

import { AnalysisCapabilityHint } from "@/components/analysis/analysis-capability-hint";
import type { AnalysisAgentKey } from "@/lib/analysis-api";

function renderHint(selectedAgents: AnalysisAgentKey[]): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AnalysisCapabilityHint projectId="proj-1" selectedAgents={selectedAgents} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  capabilityPreview.mockReset();
});
afterEach(cleanup);

describe("AnalysisCapabilityHint", () => {
  it("warns about missing code graph + source when code analysis is selected", async () => {
    capabilityPreview.mockResolvedValue({
      codeGraphPresent: false,
      repoSourceIngested: false,
      fusedCodeRetrievalEnabled: false,
      schemaContextEnabled: false,
    });
    renderHint(["document", "code"]);
    await waitFor(() => expect(screen.getByTestId("analysis-capability-hint")).toBeInTheDocument());
    expect(screen.getByTestId("capability-hint-no-code-graph")).toBeInTheDocument();
    expect(screen.getByTestId("capability-hint-source-not-ingested")).toBeInTheDocument();
    // agentMode-dependent reason is NOT asserted pre-run.
    expect(
      screen.queryByTestId("capability-hint-agentic-unavailable-no-requirements"),
    ).not.toBeInTheDocument();
  });

  it("#2454 — does not warn a Documents-only project about code it chose not to have", async () => {
    capabilityPreview.mockResolvedValue({
      codeGraphPresent: false,
      repoSourceIngested: false,
      codeConnected: false,
      // Kept off so the hint still renders: the assertions below cannot pass
      // just because the preview had not loaded yet.
      fusedCodeRetrievalEnabled: false,
      schemaContextEnabled: true,
    });
    renderHint(["document", "code"]);
    expect(
      await screen.findByTestId("capability-hint-fused-code-retrieval-disabled"),
    ).toBeVisible();
    expect(screen.queryByTestId("capability-hint-no-code-graph")).not.toBeInTheDocument();
    expect(screen.queryByTestId("capability-hint-source-not-ingested")).not.toBeInTheDocument();
  });

  it("shows no hint when code analysis is not selected and no DB gap exists", async () => {
    capabilityPreview.mockResolvedValue({
      codeGraphPresent: false,
      repoSourceIngested: false,
      fusedCodeRetrievalEnabled: false,
      schemaContextEnabled: false,
    });
    renderHint(["document"]);
    // Give the query a tick to resolve, then assert nothing rendered.
    await waitFor(() => expect(capabilityPreview).toHaveBeenCalled());
    expect(screen.queryByTestId("analysis-capability-hint")).not.toBeInTheDocument();
  });

  it("renders nothing for a fully-capable project", async () => {
    capabilityPreview.mockResolvedValue({
      codeGraphPresent: true,
      repoSourceIngested: true,
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    });
    renderHint(["document", "code", "database"]);
    await waitFor(() => expect(capabilityPreview).toHaveBeenCalled());
    expect(screen.queryByTestId("analysis-capability-hint")).not.toBeInTheDocument();
  });
});

// Issue #364 — the hint shows before any run, so it must not speak in the past
// tense ("Code was not deeply analyzed …", "… was document-grounded only").
describe("AnalysisCapabilityHint — pre-run tense (#364)", () => {
  it("says what the run will lack, not what a run lacked", async () => {
    capabilityPreview.mockResolvedValue({
      codeGraphPresent: false,
      repoSourceIngested: false,
      fusedCodeRetrievalEnabled: false,
      schemaContextEnabled: false,
    });
    renderHint(["document", "code", "database"]);
    const hint = await screen.findByTestId("analysis-capability-hint");
    expect(screen.getByTestId("capability-hint-no-code-graph")).toHaveTextContent(
      /^Code will not be deeply analyzed/,
    );
    expect(screen.getByTestId("capability-hint-source-not-ingested")).toHaveTextContent(
      /will be document-grounded only/,
    );
    expect(hint).not.toHaveTextContent(/\bwas not\b|\bwas document-grounded\b/);
  });
});

// Issue #938 — the form names the enabled custom/library agents the run will
// invoke, and says they run prompt-only: none of their tools run.
describe("AnalysisCapabilityHint — prompt-only agents (#938)", () => {
  const capable = {
    codeGraphPresent: true,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
  };

  it("lists each enabled agent, its unrun tools, and the prompt-only rule even when the run is otherwise capable", async () => {
    capabilityPreview.mockResolvedValue({
      ...capable,
      promptOnlyAgents: [
        {
          ref: "custom:ca_1",
          kind: "custom",
          name: "Go SQL reviewer",
          toolsNotRun: ["read_file_slice", "search_code"],
        },
        { ref: "library:lib_1", kind: "library", name: "Threat modeler", toolsNotRun: [] },
      ],
    });
    renderHint(["document"]);
    const notice = await screen.findByTestId("analysis-prompt-only-agents");
    expect(notice).toHaveTextContent(/run prompt-only/);
    expect(notice).toHaveTextContent(/no documents or code/);
    expect(notice).toHaveTextContent(/ungrounded/);
    expect(screen.getByTestId("prompt-only-agent-custom:ca_1")).toHaveTextContent(
      "Go SQL reviewer (custom) — its tools (read_file_slice, search_code) will not run",
    );
    expect(screen.getByTestId("prompt-only-agent-library:lib_1")).toHaveTextContent(
      /^Threat modeler \(library\)$/,
    );
    // The capability warning list stays absent — only the agent notice shows.
    expect(screen.queryByTestId("analysis-capability-hint")).not.toBeInTheDocument();
  });

  it("shows both the capability warnings and the agent notice when both apply", async () => {
    capabilityPreview.mockResolvedValue({
      ...capable,
      codeGraphPresent: false,
      promptOnlyAgents: [
        { ref: "custom:ca_1", kind: "custom", name: "Go SQL reviewer", toolsNotRun: [] },
      ],
    });
    renderHint(["document", "code"]);
    await screen.findByTestId("analysis-prompt-only-agents");
    expect(screen.getByTestId("capability-hint-no-code-graph")).toBeInTheDocument();
  });

  it("shows no agent notice when no agents are enabled", async () => {
    capabilityPreview.mockResolvedValue({ ...capable, promptOnlyAgents: [] });
    renderHint(["document"]);
    await waitFor(() => expect(capabilityPreview).toHaveBeenCalled());
    expect(screen.queryByTestId("analysis-prompt-only-agents")).not.toBeInTheDocument();
  });
});

// #1749 — a run without the code agent, on a project whose code is indexed,
// gets no code-grounded verdicts; the form says so before it starts.
describe("AnalysisCapabilityHint — code agent not selected (#1749)", () => {
  const indexed = {
    codeGraphPresent: false,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
  };

  it("warns, naming the agent, when the code is indexed and the code agent is left out", async () => {
    capabilityPreview.mockResolvedValue(indexed);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AnalysisCapabilityHint
          projectId="proj-1"
          selectedAgents={["document"]}
          codeAgentLabel="Winston (Solution Architect)"
        />
      </QueryClientProvider>,
    );
    const notice = await screen.findByTestId("analysis-code-agent-not-selected");
    expect(notice).toHaveTextContent(
      /^Winston \(Solution Architect\) is not selected, so this run will not read the project's code/,
    );
    expect(notice).toHaveTextContent(
      /no implemented, partial or gap verdict and no code citations/,
    );
  });

  it("warns when only a code graph is present, with a generic name when none is given", async () => {
    capabilityPreview.mockResolvedValue({
      ...indexed,
      repoSourceIngested: false,
      codeGraphPresent: true,
    });
    renderHint(["document", "web"]);
    expect(await screen.findByTestId("analysis-code-agent-not-selected")).toHaveTextContent(
      /^The code agent is not selected/,
    );
  });

  it("does not warn when the code agent is selected", async () => {
    capabilityPreview.mockResolvedValue(indexed);
    renderHint(["document", "code"]);
    await waitFor(() => expect(capabilityPreview).toHaveBeenCalled());
    expect(screen.queryByTestId("analysis-code-agent-not-selected")).not.toBeInTheDocument();
  });

  it("does not warn when the project has no code to read", async () => {
    capabilityPreview.mockResolvedValue({ ...indexed, repoSourceIngested: false });
    renderHint(["document"]);
    await waitFor(() => expect(capabilityPreview).toHaveBeenCalled());
    expect(screen.queryByTestId("analysis-code-agent-not-selected")).not.toBeInTheDocument();
  });
});
