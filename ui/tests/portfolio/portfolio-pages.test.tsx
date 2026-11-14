/**
 * #1626 — the portfolio coverage pages, over the real hooks with the API
 * mocked: the detail page reads only from `GET /portfolio-assessments/:id`
 * (so a reload mid-run resumes the same run), puts the answer before the
 * table, and the entry page starts a check and opens it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter, useSearchParams } from "next/navigation";
import { makeWrapper } from "../test-utils";
import { fiveStates, view } from "./fixtures";
import { axeViolations } from "./axe";

const params = { id: "pa-0000000001" };
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return {
    ...actual,
    useParams: () => params,
    useRouter: vi.fn(() => router),
    usePathname: () => "/portfolio",
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

vi.mock("@/lib/portfolio-api", () => ({
  portfolioApi: { get: vi.fn(), list: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/products-api", () => ({
  productsApi: {
    list: vi.fn().mockResolvedValue({
      items: [
        { id: "p-billing", name: "Billing" },
        { id: "p-crm", name: "CRM" },
      ],
      total: 2,
    }),
    get: vi.fn().mockResolvedValue({ id: "p-billing", name: "Billing" }),
  },
}));
const useJobLifecycle = vi.fn((_id?: string | null) => null as unknown);
vi.mock("@/hooks/use-job-events", () => ({
  useJobLifecycle: (id: string | null | undefined) => useJobLifecycle(id),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { portfolioApi } from "@/lib/portfolio-api";
import { productsApi } from "@/lib/products-api";
import { ApiError } from "@/lib/api-client";
import PortfolioAssessmentPage from "@/app/(authed)/portfolio/[id]/page";
import PortfolioPage from "@/app/(authed)/portfolio/page";

const api = vi.mocked(portfolioApi);

beforeEach(() => {
  vi.clearAllMocks();
  useJobLifecycle.mockReturnValue(null);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
});

describe("portfolio assessment page", () => {
  it("shows progress and every product in scope while it runs, from the GET", async () => {
    api.get.mockResolvedValue(
      view({ status: "running", scope: "product", productIds: ["p-billing"], productNames: {} }),
    );
    useJobLifecycle.mockReturnValue({
      jobId: params.id,
      status: "progress",
      progress: 0,
      message: "0 of 1 products checked",
    });
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByRole("status")).toHaveTextContent("0 of 1 products checked");
    expect(api.get).toHaveBeenCalledWith(params.id);
    const row = screen.getByTestId("portfolio-coverage-row");
    expect(row).toHaveAttribute("data-coverage", "not-checked");
    expect(row).toHaveTextContent("the check has not reached it yet");
    expect(screen.queryByTestId("portfolio-coverage-headline")).toBeNull();
  });

  it("resumes the same assessment after a reload: a fresh mount reads it again by id", async () => {
    api.get.mockResolvedValue(view({ status: "running", productIds: [] }));
    const first = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-assessment-progress")).toBeVisible();
    expect(screen.getByTestId("portfolio-matrix-empty")).toHaveTextContent(
      "listed as soon as the check has found them",
    );
    first.unmount();

    // A reload: a new query cache, nothing carried over but the URL.
    api.get.mockResolvedValue(fiveStates());
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(
      await screen.findByRole("heading", { name: "Covered by Billing (acme/payments)" }),
    ).toBeVisible();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get.mock.calls.every(([id]) => id === params.id)).toBe(true);
    expect(screen.queryByTestId("portfolio-assessment-progress")).toBeNull();
  });

  it("#2272 — a document check names the document, and lists what it did not check", async () => {
    api.get.mockResolvedValue({
      ...fiveStates(),
      sourceDocumentId: "doc-1",
      statement:
        'Requirements read from "Payments FRD": the model read it in full and found 2 requirements. Each is checked on its own.',
      notChecked: [{ text: "Appendix B", reason: "section-unread", count: null }],
    });
    const { container } = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByRole("heading", { name: "Document" })).toBeVisible();
    expect(screen.getByTestId("portfolio-not-checked")).toHaveTextContent(
      "Appendix B Not checked: the model could not read this section of the document.",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("#2301 — a check of a chosen set of requirements is headed as one", async () => {
    api.get.mockResolvedValue({
      ...fiveStates(),
      sourceRequirementIds: ["r-1", "r-2"],
      sourceRequirementCount: 2,
      statement: '2 chosen requirements of project "Checkout"',
    });
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByRole("heading", { name: "Chosen requirements" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Requirement" })).toBeNull();
  });

  it("#2301 — a set this reader sees only part of is still headed as a set", async () => {
    api.get.mockResolvedValue({
      ...fiveStates(),
      sourceRequirementIds: [],
      sourceRequirementCount: 1,
      statement: '1 chosen requirement of project "Checkout"',
    });
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByRole("heading", { name: "Chosen requirements" })).toBeVisible();
  });

  it("#2345 — a change request's check before approval is labelled, and links back to it", async () => {
    api.get.mockResolvedValue({
      ...fiveStates(),
      sourceAnalysisId: "an-1",
      preApproval: true,
      statement: 'Requirements of change request "Password reset"',
      changeRequest: { id: "an-1", projectId: "p1", title: "Password reset" },
    });
    const { container } = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByRole("heading", { name: "Change request" })).toBeVisible();
    expect(screen.getByTestId("portfolio-detail-pre-approval")).toHaveTextContent(
      "Run on unapproved requirements: some requirements checked were not approved",
    );
    expect(screen.getByTestId("portfolio-detail-back-to-change-request")).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=an-1",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("#2345 — a check not started from a change request keeps the global back link, unlabelled", async () => {
    api.get.mockResolvedValue({ ...fiveStates(), preApproval: false, changeRequest: null });
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText("← Back to portfolio coverage")).toBeVisible();
    expect(screen.queryByTestId("portfolio-detail-pre-approval")).toBeNull();
    expect(screen.queryByTestId("portfolio-detail-back-to-change-request")).toBeNull();
  });

  it("#2272 — a check still running lists nothing as not checked yet", async () => {
    api.get.mockResolvedValue({
      ...view({ status: "running" }),
      notChecked: [{ text: "Appendix B", reason: "section-unread", count: null }],
    });
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("portfolio-detail-statement");
    expect(screen.queryByTestId("portfolio-not-checked")).toBeNull();
  });

  it("puts the answer before the table", async () => {
    api.get.mockResolvedValue(fiveStates());
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    const headline = await screen.findByTestId("portfolio-coverage-headline");
    const table = screen.getByTestId("portfolio-coverage-matrix");
    expect(headline.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("portfolio-coverage-row")).toHaveLength(5);
  });

  it("says nothing in the portfolio covers it", async () => {
    api.get.mockResolvedValue(
      view({
        verdict: "gap-confirmed",
        productIds: ["p"],
        productNames: { p: "CRM" },
        products: [fiveStates().products[2]],
      }),
    );
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(
      await screen.findByRole("heading", { name: "Nothing in your portfolio covers this" }),
    ).toBeVisible();
  });

  it("passes axe once completed", async () => {
    api.get.mockResolvedValue(fiveStates());
    const { container } = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("portfolio-coverage-headline");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says a completed run with no products in scope had none", async () => {
    api.get.mockResolvedValue(view({ status: "completed", verdict: "could-not-verify" }));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-matrix-empty")).toHaveTextContent(
      "No products were in scope.",
    );
  });

  it("says it could not load a check it may not read", async () => {
    api.get.mockRejectedValue(new ApiError(404, "Portfolio assessment not found"));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-detail-error")).toHaveTextContent(
      "you may not have access",
    );
  });

  it("shows a loading state first", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-detail-loading")).toBeVisible();
  });
});

describe("portfolio entry page", () => {
  it("starts a check and opens it", async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: "pa-new" });
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-recent-empty")).toHaveAttribute(
      "data-slot",
      "empty-state",
    );
    await user.type(screen.getByLabelText("Requirement statement"), "Pay by transfer");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        statement: "Pay by transfer",
        scope: "all-accessible",
      }),
    );
    await waitFor(() =>
      expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith("/portfolio/pa-new"),
    );
  });

  it("arrives with a product chosen and lists that product's checks", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ productId: "p-billing" }) as never,
    );
    api.list.mockResolvedValue([
      {
        id: "pa-1",
        statement: "Pay by transfer",
        scope: "product",
        status: "completed",
        verdict: "gap-confirmed",
        productCount: 1,
        hostProductId: "p-billing",
        hostProductName: "Billing",
        createdById: "u1",
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
      {
        id: "pa-2",
        statement: "x".repeat(200),
        scope: "all-accessible",
        status: "running",
        verdict: null,
        productCount: 3,
        hostProductId: null,
        hostProductName: null,
        createdById: "u1",
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
      {
        id: "pa-3",
        statement: "Failed one",
        scope: "all-accessible",
        status: "failed",
        verdict: null,
        productCount: 2,
        hostProductId: "p-gone",
        hostProductName: null,
        createdById: "u1",
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    const items = await screen.findAllByTestId("portfolio-recent-item");
    expect(api.list).toHaveBeenCalledWith("p-billing");
    expect(within(items[0]).getByRole("link")).toHaveAttribute("href", "/portfolio/pa-1");
    // #1749 — each row says whether a product was chosen to build it.
    expect(items[0]).toHaveTextContent("Nothing covers it · 1 product · Built by Billing ·");
    expect(items[1]).toHaveTextContent(`${"x".repeat(140)}…`);
    expect(items[1]).toHaveTextContent("Running · 3 products · No product chosen to build it ·");
    expect(items[2]).toHaveTextContent("Failed · 2 products · Built by the product chosen ·");
    // #2351 — the product arrived with is ticked in the shared scope picker.
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent("Billing"),
    );
  });

  it("names a product it arrived with that is past the first page (#1680)", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ productId: "p-far" }) as never,
    );
    api.list.mockResolvedValue([]);
    vi.mocked(productsApi.get).mockResolvedValue({ id: "p-far", name: "Treasury" } as never);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent("Treasury"),
    );
    expect(productsApi.get).toHaveBeenCalledWith("p-far");
  });

  it("#1685 — does not read a product it arrived with that the first page already holds", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ productId: "p-billing" }) as never,
    );
    api.list.mockResolvedValue([]);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent("Billing"),
    );
    await waitFor(() => expect(productsApi.list).toHaveBeenCalled());
    // Give a read that should not happen the chance to start.
    await new Promise((r) => setTimeout(r, 50));
    expect(productsApi.get).not.toHaveBeenCalled();
  });

  it("encodes the product id it arrived with before reading it", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ productId: "../workspaces" }) as never,
    );
    api.list.mockResolvedValue([]);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(productsApi.get).toHaveBeenCalledWith("..%2Fworkspaces"));
  });

  it("arrives with a requirement and sends its id", async () => {
    const user = userEvent.setup();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ requirementId: "req-1", title: "Pay by transfer" }) as never,
    );
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: "pa-new" });
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-form-requirement")).toHaveTextContent("Pay by transfer");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ requirementId: "req-1", scope: "all-accessible" }),
    );
  });

  it("#2272 — arrives with a document and sends its id; it can be dropped for a statement", async () => {
    const user = userEvent.setup();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ documentId: "doc-1", title: "Payments FRD" }) as never,
    );
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: "pa-new" });
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-form-document")).toHaveTextContent("Payments FRD");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ documentId: "doc-1", scope: "all-accessible" }),
    );
    await user.click(screen.getByRole("button", { name: "Type a statement instead" }));
    expect(screen.getByLabelText("Requirement statement")).toBeVisible();
  });

  it("#2345 — arrives from a change request, sends it, labels a pre-approval check in its list, and links back", async () => {
    const user = userEvent.setup();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({
        analysisId: "an-1",
        title: "Password reset",
        projectId: "p1",
      }) as never,
    );
    api.list.mockResolvedValue([
      {
        id: "pa-1",
        statement: 'Requirements of change request "Password reset"',
        scope: "all-accessible",
        status: "completed",
        verdict: "partial",
        productCount: 2,
        hostProductId: null,
        hostProductName: null,
        sourceAnalysisId: "an-1",
        preApproval: true,
        createdById: "u1",
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
    api.create.mockResolvedValue({ id: "pa-new" });
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-form-change-request")).toHaveTextContent("Password reset");
    expect(screen.getByTestId("portfolio-back-to-change-request")).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=an-1",
    );
    const items = await screen.findAllByTestId("portfolio-recent-item");
    expect(items[0]).toHaveTextContent("Run on unapproved requirements");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ analysisId: "an-1", scope: "all-accessible" }),
    );
  });

  it("#2272 — arrives with several products chosen", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams([
        ["productId", "p-billing"],
        ["productId", "p-crm"],
        ["documentId", "doc-1"],
      ]) as never,
    );
    api.list.mockResolvedValue([]);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-form-document")).toHaveTextContent("Selected document");
    fireEvent.click(screen.getByTestId("portfolio-scope-selector"));
    expect(await screen.findByRole("checkbox", { name: "Billing" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "CRM" })).toBeChecked();
  });

  it("lets the analyst drop the requirement and type a statement", async () => {
    const user = userEvent.setup();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ requirementId: "req-1" }) as never,
    );
    api.list.mockResolvedValue([]);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-form-requirement")).toHaveTextContent(
      "Selected requirement",
    );
    await user.click(screen.getByRole("button", { name: "Type a statement instead" }));
    expect(screen.getByLabelText("Requirement statement")).toBeVisible();
  });

  it("shows the server's refusal inline", async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue([]);
    api.create.mockRejectedValue(new ApiError(404, "Requirement not found"));
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Requirement not found");
  });

  it("shows a generic message for an unexpected failure", async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue([]);
    api.create.mockRejectedValue(new Error("boom"));
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start the check");
  });

  it("says when recent checks could not load", async () => {
    api.list.mockRejectedValue(new Error("down"));
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText("Could not load recent checks.")).toBeVisible();
  });

  it("passes axe", async () => {
    api.list.mockResolvedValue([]);
    const { container } = render(<PortfolioPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("portfolio-recent-empty");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("#1673 — the coverage pages' follow-ups", () => {
  const products = vi.mocked(productsApi.list);

  it("keeps the last answer on screen when a re-read fails, and says so", async () => {
    api.get.mockResolvedValueOnce(view({ status: "running", productIds: ["p-billing"] }));
    const { rerender } = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("portfolio-detail-root");
    api.get.mockRejectedValue(new ApiError(503, "Unavailable"));
    // A job event re-reads it; the read fails.
    useJobLifecycle.mockReturnValue({ jobId: "pa-0000000001", status: "started" });
    rerender(<PortfolioAssessmentPage />);
    expect(await screen.findByTestId("portfolio-detail-stale")).toHaveTextContent(
      "Could not refresh this check just now. Showing what was last loaded",
    );
    expect(screen.getByTestId("portfolio-detail-statement")).toBeVisible();
    expect(screen.queryByTestId("portfolio-detail-error")).toBeNull();
  });

  it("says a check that is gone or no longer readable cannot be refreshed", async () => {
    api.get.mockResolvedValueOnce(view({ status: "running" }));
    const { rerender } = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("portfolio-detail-root");
    api.get.mockRejectedValue(new ApiError(404, "Portfolio assessment not found"));
    useJobLifecycle.mockReturnValue({ jobId: "pa-0000000001", status: "started" });
    rerender(<PortfolioAssessmentPage />);
    expect(await screen.findByTestId("portfolio-detail-stale")).toHaveTextContent(
      "This check can no longer be refreshed",
    );
  });

  it("says a failed check failed before it found its products, not that there were none", async () => {
    api.get.mockResolvedValue(view({ status: "failed", productIds: [] }));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-matrix-empty")).toHaveTextContent(
      "The check failed before it found the products in scope.",
    );
    // A failed check still exports, on purpose: what was asked, and that it failed.
    expect(screen.getByTestId("portfolio-export-md")).toBeEnabled();
  });

  it("starts the form afresh when the search params change, so it never sends a stale requirement", async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: "pa-new" });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ requirementId: "req-1", title: "First" }) as never,
    );
    const { rerender } = render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("portfolio-form-requirement")).toHaveTextContent("First");
    // A client navigation to the same page with another requirement.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ requirementId: "req-2", title: "Second" }) as never,
    );
    rerender(<PortfolioPage />);
    expect(screen.getByTestId("portfolio-form-requirement")).toHaveTextContent("Second");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ requirementId: "req-2", scope: "all-accessible" }),
    );
  });

  it("searches every product, a full page at a time, and says when the list is partial", async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue([]);
    products.mockResolvedValue({
      items: [
        { id: "p-billing", name: "Billing" },
        { id: "p-crm", name: "CRM" },
      ],
      total: 140,
    } as never);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(products).toHaveBeenCalledWith({ pageSize: 100 });
    expect(await screen.findByText(/Showing 2 of 140 products/)).toBeVisible();
    await user.type(screen.getByLabelText("Find products"), "ledg");
    await waitFor(() => expect(products).toHaveBeenCalledWith({ pageSize: 100, search: "ledg" }));
  });
});
