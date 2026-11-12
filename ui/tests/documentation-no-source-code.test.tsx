/**
 * #2369 — the Generate form says, before the run, that a code-based document
 * (Full Project or By Repository) has nothing to read on a project with no
 * indexed source code — a documents-only project.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {},
}));

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

function serve(indexed: boolean): void {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === "/projects/proj_test/docs/source-code") return { indexed };
    if (path.includes("/connectors/repos")) return [];
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

describe("DocumentationPage — no indexed source code (#2369)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("warns on Full Project that the chosen document type needs source code", async () => {
    serve(false);
    await openForm();
    const warning = await screen.findByTestId("no-source-code-warning");
    expect(warning).toHaveTextContent(/Business Requirements needs connected source code/);
    expect(warning).toHaveTextContent(/Requirements \(analysis run\)/);
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_test/docs/source-code");
  });

  it("names the document type the user picked", async () => {
    serve(false);
    await openForm();
    fireEvent.change(screen.getByTestId("doc-type-select"), { target: { value: "architecture" } });
    expect(await screen.findByTestId("no-source-code-warning")).toHaveTextContent(
      /Architecture Overview needs connected source code/,
    );
  });

  it("warns on By Repository too, and not on a scope that does not read code", async () => {
    serve(false);
    await openForm();
    await screen.findByTestId("no-source-code-warning");
    fireEvent.change(screen.getByTestId("doc-scope-select"), { target: { value: "repository" } });
    expect(await screen.findByTestId("no-source-code-warning")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("doc-scope-select"), {
      target: { value: "requirements" },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("no-source-code-warning")).not.toBeInTheDocument(),
    );
  });

  it("does not warn when the answer is unknown (the check failed)", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === "/projects/proj_test/docs/source-code") throw new Error("network");
      return [];
    });
    await openForm();
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_test/docs/source-code"),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("no-source-code-warning")).not.toBeInTheDocument();
  });

  it("does not warn when the project has indexed source code", async () => {
    serve(true);
    await openForm();
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_test/docs/source-code"),
    );
    // Let the query settle before asserting absence.
    await screen.findByTestId("doc-type-select");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("no-source-code-warning")).not.toBeInTheDocument();
  });
});
