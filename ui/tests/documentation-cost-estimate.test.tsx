/**
 * #2189 — the Generate form shows what a business-requirements document of the
 * chosen scope is estimated to cost, before the run starts: a range, or why
 * there is none — never "$0" for a model with no price.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
  useSearchParams: vi.fn(() => new URLSearchParams(window.location.search)),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {},
}));

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

const PLAN = {
  modules: 10,
  modulesToExtract: 4,
  sourceLines: 202,
  sections: 7,
  modelCalls: 42,
  estimatedDocumentChars: 131_000,
};

const PRICED = {
  status: "priced",
  lowUsd: 1.58,
  highUsd: 3.39,
  models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-4-5"],
  unpricedModels: [],
  freeModels: [],
  plan: PLAN,
};

const ESTIMATE_PATH = "/projects/proj_test/docs/cost-estimate";

function serve(estimate: unknown, indexed = true): void {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === "/projects/proj_test/docs/source-code") return { indexed };
    if (path === ESTIMATE_PATH) {
      if (estimate instanceof Error) throw estimate;
      return estimate;
    }
    if (path.includes("/connectors/repos")) {
      return [{ id: "repo-1", label: "billing", repoUrl: "", status: "ready", isPrimary: true }];
    }
    if (path.includes("/analyses")) return { items: [] };
    return [];
  });
}

async function openForm(): Promise<void> {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
  fireEvent.click(await screen.findByTestId("generate-docs-btn"));
  await screen.findByTestId("generate-form");
}

const estimateCalls = () => mockApiFetch.mock.calls.filter(([path]) => path === ESTIMATE_PATH);

describe("DocumentationPage — BRD cost estimate (#2189)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the estimated range for a whole-project BRD before the run", async () => {
    serve(PRICED);
    await openForm();
    const note = await screen.findByTestId("cost-estimate");
    expect(screen.getByTestId("cost-estimate-range")).toHaveTextContent("$1.58 – $3.39");
    expect(note).toHaveTextContent(/10 modules \(4 to read for the first time\)/);
    expect(note).toHaveTextContent(/7 sections, about 42 model calls/);
    expect(note).toHaveTextContent(/anthropic\/claude-sonnet-5-5, anthropic\/claude-haiku-4-5/);
    expect(mockApiFetch).toHaveBeenCalledWith(ESTIMATE_PATH);
  });

  it("says when every module's facts are already extracted", async () => {
    serve({ ...PRICED, plan: { ...PLAN, modulesToExtract: 0 } });
    await openForm();
    expect(await screen.findByTestId("cost-estimate")).toHaveTextContent(
      /facts already extracted for all of them/,
    );
  });

  it("lists a model with no per-token price that the range leaves out", async () => {
    serve({ ...PRICED, freeModels: ["local-gemma/laguna-s-2.1"] });
    await openForm();
    expect(await screen.findByTestId("cost-estimate")).toHaveTextContent(
      /Not counted, with no per-token price: local-gemma\/laguna-s-2.1/,
    );
  });

  it("names an unpriced model instead of showing a figure", async () => {
    serve({
      ...PRICED,
      status: "unpriced",
      lowUsd: null,
      highUsd: null,
      unpricedModels: ["anthropic/mystery-model"],
    });
    await openForm();
    const note = await screen.findByTestId("cost-estimate-unpriced");
    expect(note).toHaveTextContent(/METIS has no price for anthropic\/mystery-model/);
    expect(note).not.toHaveTextContent("$");
    expect(screen.queryByTestId("cost-estimate")).not.toBeInTheDocument();
  });

  it("says a self-hosted run has no per-token cost", async () => {
    serve({
      ...PRICED,
      status: "free",
      lowUsd: null,
      highUsd: null,
      freeModels: ["local-gemma/laguna-s-2.1"],
    });
    await openForm();
    expect(await screen.findByTestId("cost-estimate-free")).toHaveTextContent(
      /local-gemma\/laguna-s-2.1, which has no per-token price/,
    );
  });

  it("says a scope with no documentable code has nothing to estimate", async () => {
    serve({ ...PRICED, status: "no-code", lowUsd: null, highUsd: null });
    await openForm();
    expect(await screen.findByTestId("cost-estimate-no-code")).toBeInTheDocument();
  });

  it("says when the estimate could not be made", async () => {
    serve(new Error("400"));
    await openForm();
    expect(await screen.findByTestId("cost-estimate-error")).toBeInTheDocument();
  });

  it("estimates the chosen repository, once one is chosen", async () => {
    serve(PRICED);
    await openForm();
    await screen.findByTestId("cost-estimate");
    fireEvent.change(screen.getByTestId("doc-scope-select"), { target: { value: "repository" } });
    await waitFor(() => expect(screen.queryByTestId("cost-estimate")).not.toBeInTheDocument());
    const select = await screen.findByTestId("repo-connector-select");
    await screen.findByRole("option", { name: "billing" });
    fireEvent.change(select, { target: { value: "repo-1" } });
    await screen.findByTestId("cost-estimate");
    expect(mockApiFetch).toHaveBeenCalledWith(ESTIMATE_PATH, {
      params: { repoConnectorId: "repo-1" },
    });
  });

  it("estimates the typed path prefixes", async () => {
    serve(PRICED);
    await openForm();
    await screen.findByTestId("cost-estimate");
    fireEvent.change(screen.getByTestId("doc-path-scope-input"), {
      target: { value: "packages/fit/" },
    });
    await waitFor(
      () =>
        expect(mockApiFetch).toHaveBeenCalledWith(ESTIMATE_PATH, {
          params: { pathPrefixes: "packages/fit/" },
        }),
      { timeout: 2_000 },
    );
  });

  it("shows the estimate as loading while the path field differs from the estimated scope", async () => {
    serve(PRICED);
    await openForm();
    await screen.findByTestId("cost-estimate");
    fireEvent.change(screen.getByTestId("doc-path-scope-input"), {
      target: { value: "packages/fit/" },
    });
    // Mid-debounce: the range shown would be the previous scope's.
    expect(screen.queryByTestId("cost-estimate")).not.toBeInTheDocument();
    expect(screen.getByTestId("cost-estimate-loading")).toBeInTheDocument();
    await screen.findByTestId("cost-estimate", undefined, { timeout: 2_000 });
  });

  it("does not estimate another document type", async () => {
    serve(PRICED);
    await openForm();
    await screen.findByTestId("cost-estimate");
    fireEvent.change(screen.getByTestId("doc-type-select"), { target: { value: "architecture" } });
    await waitFor(() => expect(screen.queryByTestId("cost-estimate")).not.toBeInTheDocument());
  });

  it("does not estimate a project with no indexed code", async () => {
    serve(PRICED, false);
    await openForm();
    await screen.findByTestId("no-source-code-warning");
    expect(screen.queryByTestId("cost-estimate")).not.toBeInTheDocument();
    expect(estimateCalls()).toHaveLength(0);
  });
});
