/**
 * #2301 — a portfolio check of a chosen set of stored requirements: ticked on a
 * project's Requirements tab, carried to the portfolio page by id, sent as
 * `requirementIds` as the contract accepts them, and re-opened on the same set
 * by the host-picker link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { PORTFOLIO_MAX_REQUIREMENTS, createPortfolioAssessmentSchema } from "@metis/shared";
import { makeWrapper, userWith } from "../test-utils";
import { view } from "./fixtures";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return {
    ...actual,
    useRouter: vi.fn(() => router),
    usePathname: () => "/portfolio",
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});
const portfolioApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/portfolio-api", () => ({ portfolioApi }));
const productsApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/products-api", () => ({ productsApi }));
vi.mock("@/lib/projects-api", () => ({ projectsApi: { get: vi.fn() } }));
const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/requirements-list-api", () => ({ requirementsListApi: { list } }));
vi.mock("@/lib/analysis-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject: vi.fn().mockResolvedValue({ items: [] }) },
}));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PortfolioPage from "@/app/(authed)/portfolio/page";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { portfolioCheckHref } from "@/components/portfolio/portfolio-check-link";
import {
  PORTFOLIO_SET_TOO_BIG_HINT,
  RequirementsList,
  REQUIREMENTS_PAGE_SIZE,
} from "@/components/requirements/requirements-list";
import { hostPickerHref } from "@/lib/portfolio-impact";

const row = (id: string, title: string) => ({
  id,
  title,
  body: "Body",
  version: 1,
  reviewStatus: "approved",
  updatedAt: "2026-11-10T00:00:00.000Z",
  changeRequest: { id: "cr-1", title: "Checkout" },
  review: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  productsApi.list.mockResolvedValue({ items: [{ id: "p-billing", name: "Billing" }], total: 1 });
  portfolioApi.list.mockResolvedValue([]);
  portfolioApi.create.mockResolvedValue({ id: "pa-1" });
  apiFetch.mockResolvedValue([]);
});

describe("#2301 — the links carry the set", () => {
  it("the check link carries every id, in order, and a bounded title", () => {
    const url = new URL(
      portfolioCheckHref({ requirementIds: ["r-2", "r-1"], title: "x".repeat(300) }),
      "http://x",
    );
    expect(url.pathname).toBe("/portfolio");
    expect(url.searchParams.getAll("requirementIds")).toEqual(["r-2", "r-1"]);
    expect(url.searchParams.get("title")).toBe("x".repeat(200));
  });

  it("the host-picker link re-opens a set check on the same set and products", () => {
    const url = new URL(
      hostPickerHref(
        view({
          sourceRequirementIds: ["r-2", "r-1"],
          sourceRequirementCount: 2,
          sourceProjectId: "proj-1",
          statement: '2 chosen requirements of project "Checkout"',
          scope: "product",
          productIds: ["p-billing"],
        }),
      )!,
      "http://x",
    );
    expect(url.searchParams.getAll("requirementIds")).toEqual(["r-2", "r-1"]);
    expect(url.searchParams.get("title")).toBe('2 chosen requirements of project "Checkout"');
    expect(url.searchParams.has("statement")).toBe(false);
    expect(url.searchParams.has("requirementId")).toBe(false);
    expect(url.searchParams.getAll("productId")).toEqual(["p-billing"]);
    expect(url.hash).toBe("#portfolio-host");
  });

  it("offers no re-open link to a reader the set holds a requirement they cannot see for", () => {
    // The server names only the requirements this reader can see, and counts the set.
    const partial = view({
      sourceRequirementIds: ["r-2"],
      sourceRequirementCount: 2,
      sourceProjectId: "proj-1",
      statement: '2 chosen requirements of project "Checkout"',
    });
    expect(hostPickerHref(partial)).toBeNull();
    expect(
      hostPickerHref({ ...partial, sourceRequirementIds: [], sourceRequirementCount: 1 })!,
    ).toBeNull();
    // Every one visible: the link re-opens the set.
    expect(
      hostPickerHref({
        ...partial,
        sourceRequirementIds: ["r-2", "r-1"],
        sourceRequirementCount: 2,
      })!,
    ).toContain("requirementIds=r-2&requirementIds=r-1");
  });

  it("a check of one requirement or a typed statement is carried as before", () => {
    const typed = new URL(hostPickerHref(view({ sourceRequirementIds: [] }))!, "http://x");
    expect(typed.searchParams.has("requirementIds")).toBe(false);
    expect(typed.searchParams.get("statement")).toBe(view().statement);
  });
});

describe("#2301 — the form sends the set", () => {
  it("sends requirementIds as the contract accepts them, and offers a typed statement instead", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClear = vi.fn();
    render(
      <PortfolioAssessmentForm
        products={[]}
        pending={false}
        onSubmit={onSubmit}
        requirementSet={{ ids: ["r-2", "r-1"], title: "2 chosen requirements" }}
        onClearRequirementSet={onClear}
      />,
    );
    const shown = screen.getByTestId("portfolio-form-requirement-set");
    expect(shown).toHaveTextContent("2 chosen requirements");
    expect(shown).toHaveTextContent("METIS checks each of the 2 requirements on its own.");
    expect(screen.queryByLabelText("Requirement statement")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({ requirementIds: ["r-2", "r-1"], scope: "all-accessible" });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
    await user.click(screen.getByRole("button", { name: "Type a statement instead" }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe("#2301 — the portfolio page arriving with a set", () => {
  it("reads every id from the link and starts a check of the set", async () => {
    const params = new URLSearchParams();
    params.append("requirementIds", "r-2");
    params.append("requirementIds", "r-1");
    params.set("title", "2 chosen requirements");
    vi.mocked(useSearchParams).mockReturnValue(params as never);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-form-requirement-set")).toHaveTextContent(
      "2 chosen requirements",
    );
    const submit = screen.getByRole("button", { name: "Check coverage" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(portfolioApi.create).toHaveBeenCalled());
    expect(portfolioApi.create.mock.calls[0][0]).toEqual({
      requirementIds: ["r-2", "r-1"],
      scope: "all-accessible",
    });
  });

  it("names a set that came without a title by its size", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams([["requirementIds", "r-1"]]) as never,
    );
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-form-requirement-set")).toHaveTextContent(
      "1 chosen requirement",
    );
  });
});

describe("#2301 — the Requirements tab starts one from the rows ticked", () => {
  function renderList(...permissions: Parameters<typeof userWith>) {
    const Wrapper = makeWrapper({ initialUser: userWith(...permissions) });
    return render(
      <Wrapper>
        <RequirementsList projectId="p1" />
      </Wrapper>,
    );
  }

  it("links the ticked rows to a check of each, for a role that may start one", async () => {
    list.mockResolvedValue({
      items: [row("r-1", "Pay by card"), row("r-2", "Refund in 30 days")],
      total: 2,
      page: 1,
      pageSize: REQUIREMENTS_PAGE_SIZE,
    });
    // A role that may start a check but not request a review still ticks rows.
    renderList("analysis.run");
    await screen.findByTestId("requirements-row-r-1");
    expect(screen.queryByTestId("requirements-portfolio")).toBeNull();
    fireEvent.click(
      screen.getByLabelText("Choose Refund in 30 days to check across the portfolio"),
    );
    fireEvent.click(screen.getByLabelText("Choose Pay by card to check across the portfolio"));
    const link = screen.getByTestId("requirements-portfolio-check");
    expect(link).toHaveTextContent("Check 2 selected across portfolio");
    const url = new URL(link.getAttribute("href")!, "http://x");
    expect(url.pathname).toBe("/portfolio");
    expect(url.searchParams.getAll("requirementIds")).toEqual(["r-2", "r-1"]);
    expect(url.searchParams.get("title")).toBe("2 chosen requirements");
  });

  it("offers no check to a role that may not start one", async () => {
    list.mockResolvedValue({
      items: [row("r-1", "Pay by card")],
      total: 1,
      page: 1,
      pageSize: REQUIREMENTS_PAGE_SIZE,
    });
    renderList("review.create");
    fireEvent.click(await screen.findByLabelText("Choose Pay by card for a review"));
    expect(screen.queryByTestId("requirements-portfolio")).toBeNull();
    expect(screen.queryByTestId("requirements-portfolio-check")).toBeNull();
  });

  it(`holds the check, and says why, past the ${PORTFOLIO_MAX_REQUIREMENTS} one check takes`, async () => {
    const many = Array.from({ length: PORTFOLIO_MAX_REQUIREMENTS + 1 }, (_, i) =>
      row(`r-${i}`, `Requirement ${i}`),
    );
    list.mockResolvedValue({
      items: many,
      total: many.length,
      page: 1,
      pageSize: REQUIREMENTS_PAGE_SIZE,
    });
    renderList("analysis.run");
    await screen.findByTestId("requirements-row-r-0");
    for (const r of many.slice(0, PORTFOLIO_MAX_REQUIREMENTS)) {
      fireEvent.click(screen.getByLabelText(`Choose ${r.title} to check across the portfolio`));
    }
    expect(screen.getByTestId("requirements-portfolio-check")).toHaveTextContent(
      `Check ${PORTFOLIO_MAX_REQUIREMENTS} selected`,
    );
    fireEvent.click(
      screen.getByLabelText(
        `Choose Requirement ${PORTFOLIO_MAX_REQUIREMENTS} to check across the portfolio`,
      ),
    );
    expect(screen.queryByTestId("requirements-portfolio-check")).toBeNull();
    const held = screen.getByRole("button", {
      name: `Check ${PORTFOLIO_MAX_REQUIREMENTS + 1} selected across portfolio`,
    });
    expect(held).toBeDisabled();
    expect(PORTFOLIO_SET_TOO_BIG_HINT).toContain(String(PORTFOLIO_MAX_REQUIREMENTS));
  });
});
