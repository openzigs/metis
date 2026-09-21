/**
 * Documentation page — GenerateForm multi-scope dropdown tests.
 * Epic #671 (Issue #675) + Epic #672 (Issue #678).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));

// Mock apiFetch
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {
    status: number;
    code: string | undefined;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

// Sample data
const sampleDocs: never[] = [];

const sampleRepos = [
  {
    id: "repo_1",
    label: "ASIS",
    repoUrl: "https://github.com/org/asis.git",
    status: "connected",
    isPrimary: true,
  },
  {
    id: "repo_2",
    label: "EPV",
    repoUrl: "https://github.com/org/epv.git",
    status: "connected",
    isPrimary: false,
  },
];

const sampleDbs = [
  {
    id: "db_1",
    label: "Production DB",
    driver: "postgres",
    host: "db.prod",
    databaseName: "metis",
    status: "connected",
  },
  {
    id: "db_2",
    label: "Staging DB",
    driver: "postgres",
    host: "db.staging",
    databaseName: "metis_stg",
    status: "disconnected",
  },
];

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocumentationPage — GenerateForm scope selection", () => {
  beforeEach(() => {
    // Default: docs list returns empty
    mockApiFetch.mockResolvedValue(sampleDocs);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the generate button and shows the form when clicked", async () => {
    renderPage();
    const btn = await screen.findByTestId("generate-docs-btn");
    fireEvent.click(btn);
    expect(await screen.findByTestId("generate-form")).toBeInTheDocument();
  });

  it("shows Full Project scope by default and no connector dropdowns", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    const scopeSelect = await screen.findByTestId("doc-scope-select");
    expect((scopeSelect as HTMLSelectElement).value).toBe("full");
    expect(screen.queryByTestId("repo-connector-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("db-connector-select")).not.toBeInTheDocument();
  });

  it("shows repo connector dropdown when 'By Repository' is selected", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/repos")) return sampleRepos;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    const scopeSelect = await screen.findByTestId("doc-scope-select");
    fireEvent.change(scopeSelect, { target: { value: "repository" } });

    await waitFor(() => {
      expect(screen.getByTestId("repo-connector-select")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("db-connector-select")).not.toBeInTheDocument();
  });

  it("populates repo dropdown with fetched connectors", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/repos")) return sampleRepos;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "repository" },
    });

    await waitFor(() => {
      const select = screen.getByTestId("repo-connector-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain("repo_1");
      expect(options).toContain("repo_2");
    });
  });

  it("auto-suggests title when a repo is selected", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/repos")) return sampleRepos;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "repository" },
    });

    // Wait for options to populate before selecting
    await waitFor(() => {
      const select = screen.getByTestId("repo-connector-select") as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toContain("repo_1");
    });

    fireEvent.change(screen.getByTestId("repo-connector-select"), {
      target: { value: "repo_1" },
    });

    await waitFor(() => {
      const titleInput = screen.getByTestId("doc-title-input") as HTMLInputElement;
      expect(titleInput.value).toContain("ASIS");
    });
  });

  it("shows database connector dropdown when 'Database Schema' is selected", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/dbs")) return sampleDbs;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "database" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("db-connector-select")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("repo-connector-select")).not.toBeInTheDocument();
  });

  it("only shows connected databases in the dropdown", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/dbs")) return sampleDbs;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "database" },
    });

    await waitFor(() => {
      const select = screen.getByTestId("db-connector-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      // Only status=connected should appear
      expect(options).toContain("db_1");
      expect(options).not.toContain("db_2");
    });
  });

  it("shows 'no connected databases' message when all dbs are disconnected", async () => {
    const disconnectedDbs = sampleDbs.map((db) => ({ ...db, status: "disconnected" }));
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/dbs")) return disconnectedDbs;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "database" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("no-connected-dbs")).toBeInTheDocument();
    });
  });

  it("hides doc type selector when database scope is active", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/dbs")) return sampleDbs;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "database" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("doc-type-select")).not.toBeInTheDocument();
    });
  });

  it("auto-suggests title as '{label} Schema' when a db is selected", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/dbs")) return sampleDbs;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "database" },
    });

    // Wait for connected db options to populate before selecting
    await waitFor(() => {
      const select = screen.getByTestId("db-connector-select") as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toContain("db_1");
    });

    fireEvent.change(screen.getByTestId("db-connector-select"), {
      target: { value: "db_1" },
    });

    await waitFor(() => {
      const titleInput = screen.getByTestId("doc-title-input") as HTMLInputElement;
      expect(titleInput.value).toBe("Production DB Schema");
    });
  });

  it("disables submit when repository scope is selected but no repo is chosen", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/repos")) return sampleRepos;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "repository" },
    });

    await waitFor(() => screen.getByTestId("repo-connector-select"));

    const submitBtn = screen.getByTestId("submit-generate") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it("disables submit when database scope is selected but no db is chosen", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/connectors/dbs")) return sampleDbs;
      return sampleDocs;
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.change(await screen.findByTestId("doc-scope-select"), {
      target: { value: "database" },
    });

    await waitFor(() => screen.getByTestId("db-connector-select"));

    const submitBtn = screen.getByTestId("submit-generate") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  // ── #283 — opt-in domain web-research grounding toggle ──────────────────

  it("shows the domain web-research toggle for business-requirements + full scope, OFF by default", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    const toggle = (await screen.findByTestId("ground-domain-web-research")) as HTMLInputElement;
    // Visible (business-requirements is the default doc type, full is the default scope).
    expect(toggle).toBeInTheDocument();
    // Default OFF — no surprise network calls / cost.
    expect(toggle.checked).toBe(false);
  });

  it("hides the domain web-research toggle for non-business-requirements doc types", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    const docTypeSelect = await screen.findByTestId("doc-type-select");
    fireEvent.change(docTypeSelect, { target: { value: "architecture" } });
    await waitFor(() => {
      expect(screen.queryByTestId("ground-domain-web-research")).not.toBeInTheDocument();
    });
  });

  it("does NOT send groundDomainWithWebResearch when the toggle is left off (default-off safety)", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.click(screen.getByTestId("submit-generate"));

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/docs/generate"),
      );
      expect(call).toBeDefined();
      const body = (call![1] as { body: { groundDomainWithWebResearch?: boolean } }).body;
      // Off → either absent or explicitly false; never true.
      expect(body.groundDomainWithWebResearch ?? false).toBe(false);
    });
  });

  it("sends groundDomainWithWebResearch=true when the toggle is enabled", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.click(await screen.findByTestId("ground-domain-web-research"));
    fireEvent.click(screen.getByTestId("submit-generate"));

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/docs/generate"),
      );
      expect(call).toBeDefined();
      const body = (call![1] as { body: { groundDomainWithWebResearch?: boolean } }).body;
      expect(body.groundDomainWithWebResearch).toBe(true);
    });
  });

  // Issue #58 — screen-reader audit. The GenerateForm controls were labelled by
  // bare <label> elements with no htmlFor/id association — invisible to SR users
  // (announced as unlabelled comboboxes). They are now programmatically named.
  describe("screen-reader affordances (#58)", () => {
    beforeEach(() => {
      mockApiFetch.mockResolvedValue(sampleDocs);
    });

    it("associates every GenerateForm control with its label", async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId("generate-docs-btn"));
      await screen.findByTestId("generate-form");

      // getByLabelText only resolves when the label is programmatically linked
      // to the control (htmlFor/id), so these assertions fail on the old markup.
      expect(screen.getByLabelText("Scope")).toHaveAttribute("id", "doc-scope-select");
      expect(screen.getByLabelText("Document Type")).toHaveAttribute("id", "doc-type-select");
      expect(screen.getByLabelText("Title")).toHaveAttribute("id", "doc-title-input");
    });
  });
});
