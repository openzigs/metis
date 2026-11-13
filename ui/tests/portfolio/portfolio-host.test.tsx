/**
 * #1725 — the host product: the form's "Which product will build this?"
 * picker sends `hostProductId`; the result names the host; and a check nothing
 * covers, with no host, says impact needs one and links back to the picker
 * instead of "No product needs to change".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { createPortfolioAssessmentSchema } from "@metis/shared";
import { makeWrapper } from "../test-utils";
import { product, view } from "./fixtures";
import { impactView } from "./impact-fixtures";
import { axeViolations } from "./axe";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { PortfolioImpactView } from "@/components/portfolio/portfolio-impact-view";
import {
  HOST_LINK_STATEMENT_MAX,
  hostPickerHref,
  impactGroups,
  impactNeedsHost,
} from "@/lib/portfolio-impact";

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
        { id: "p-orders", name: "Orders" },
        { id: "p-billing", name: "Billing" },
      ],
      total: 2,
    }),
    get: vi.fn(),
  },
}));
vi.mock("@/hooks/use-job-events", () => ({ useJobLifecycle: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { portfolioApi } from "@/lib/portfolio-api";
import PortfolioAssessmentPage from "@/app/(authed)/portfolio/[id]/page";
import PortfolioPage from "@/app/(authed)/portfolio/page";

const api = vi.mocked(portfolioApi);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
});

const products = [
  { id: "p-orders", name: "Orders" },
  { id: "p-billing", name: "Billing" },
];

function setupForm(props: Partial<Parameters<typeof PortfolioAssessmentForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <PortfolioAssessmentForm products={products} pending={false} onSubmit={onSubmit} {...props} />,
  );
  return { onSubmit, ...utils };
}

/** A completed check of three products none of which covers the statement. */
function nothingCovers(over: Parameters<typeof view>[0] = {}) {
  return view({
    statement: "Customers must have a verified mobile phone number.",
    productIds: ["p-orders", "p-billing"],
    verdict: "gap-confirmed",
    productNames: { "p-orders": "Orders", "p-billing": "Billing" },
    products: [product("p-orders", "not-covered"), product("p-billing", "not-covered")],
    ...over,
  });
}

describe("the host picker", () => {
  it("sends the product chosen to build it across every product", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setupForm();
    await user.type(screen.getByLabelText("Requirement statement"), "Add a phone field");
    const host = screen.getByLabelText("Which product will build this? (optional)");
    expect(host).toHaveValue("");
    expect(
      within(host)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Not decided yet", "Orders", "Billing"]);
    await user.selectOptions(host, "p-orders");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({
      statement: "Add a phone field",
      scope: "all-accessible",
      hostProductId: "p-orders",
    });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("sends no host when none is chosen", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setupForm();
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("hostProductId");
  });

  it("in one product's scope, offers only that product, and drops a host the scope no longer holds", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setupForm();
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.selectOptions(
      screen.getByLabelText("Which product will build this? (optional)"),
      "p-billing",
    );
    // #2351 — one product ticked in the shared scope picker.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    await user.click(screen.getByRole("checkbox", { name: "Orders" }));
    const host = screen.getByLabelText("Which product will build this? (optional)");
    // Billing was picked across every product: one product's scope cannot host on it.
    expect(host).toHaveValue("");
    expect(
      within(host)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Not decided yet", "Orders"]);
    await user.selectOptions(host, "p-orders");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({
      statement: "x",
      scope: "product",
      productIds: ["p-orders"],
      hostProductId: "p-orders",
    });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("searches for a host across every product, and keeps the one chosen as the list narrows", async () => {
    const user = userEvent.setup();
    const onProductQueryChange = vi.fn();
    const { onSubmit, rerender } = setupForm({ onProductQueryChange });
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.selectOptions(
      screen.getByLabelText("Which product will build this? (optional)"),
      "p-billing",
    );
    await user.type(screen.getByLabelText("Find a product to build it"), "o");
    expect(onProductQueryChange).toHaveBeenLastCalledWith("o");
    rerender(
      <PortfolioAssessmentForm
        products={[products[0]]}
        onProductQueryChange={onProductQueryChange}
        productQuery="o"
        pending={false}
        onSubmit={onSubmit}
      />,
    );
    const host = screen.getByLabelText("Which product will build this? (optional)");
    expect(host).toHaveValue("p-billing");
    expect(within(host).getByRole("option", { name: "Billing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0].hostProductId).toBe("p-billing");
  });

  it("starts from a statement it was given", () => {
    setupForm({ initialStatement: "Add a phone field" });
    expect(screen.getByLabelText("Requirement statement")).toHaveValue("Add a phone field");
  });

  it("passes axe with the picker", async () => {
    const { container } = setupForm({ onProductQueryChange: vi.fn() });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("impactNeedsHost", () => {
  it("holds for a finished check nothing covers, with no host and nothing reached", () => {
    expect(impactNeedsHost(nothingCovers())).toBe(true);
  });

  it("does not hold once a host was chosen, something covers it, it changes something, or it is running", () => {
    expect(impactNeedsHost(nothingCovers({ hostProductId: "p-orders" }))).toBe(false);
    expect(
      impactNeedsHost(
        nothingCovers({
          products: [product("p-orders", "covers"), product("p-billing", "not-covered")],
        }),
      ),
    ).toBe(false);
    expect(
      impactNeedsHost(
        nothingCovers({
          products: [
            product("p-orders", "partial", {}, { impactKind: "direct-change" }),
            product("p-billing", "not-covered"),
          ],
        }),
      ),
    ).toBe(false);
    expect(impactNeedsHost(nothingCovers({ status: "running" }))).toBe(false);
  });

  it("a covering product outside the scope does not count", () => {
    expect(
      impactNeedsHost(
        nothingCovers({
          products: [
            product("p-orders", "not-covered"),
            product("p-billing", "not-covered"),
            product("p-other", "covers"),
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("hostPickerHref", () => {
  it("carries a typed statement to the picker", () => {
    const href = hostPickerHref(nothingCovers());
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/portfolio");
    expect(url.hash).toBe("#portfolio-host");
    expect(url.searchParams.get("statement")).toBe(
      "Customers must have a verified mobile phone number.",
    );
    expect(url.searchParams.has("requirementId")).toBe(false);
  });

  it("carries a requirement by id, titled by the statement's first line", () => {
    const url = new URL(
      hostPickerHref(
        nothingCovers({ sourceRequirementId: "req-1", statement: "Phone numbers\n\nBody text" }),
      ),
      "http://x",
    );
    expect(url.searchParams.get("requirementId")).toBe("req-1");
    expect(url.searchParams.get("title")).toBe("Phone numbers");
    expect(url.searchParams.has("statement")).toBe(false);
  });

  it("leaves out a statement too long for a link, and keeps one product's scope", () => {
    const url = new URL(
      hostPickerHref(
        nothingCovers({
          statement: "x".repeat(HOST_LINK_STATEMENT_MAX + 1),
          scope: "product",
          productIds: ["p-orders"],
        }),
      ),
      "http://x",
    );
    expect(url.searchParams.has("statement")).toBe(false);
    expect(url.searchParams.get("productId")).toBe("p-orders");
    expect(
      hostPickerHref(nothingCovers({ statement: "x".repeat(HOST_LINK_STATEMENT_MAX) })),
    ).toContain("statement=");
  });
});

describe("PortfolioImpactView — the host", () => {
  it("names the host and badges its card", () => {
    const groups = impactGroups(impactView());
    render(
      <PortfolioImpactView
        affected={groups.affected}
        notAffected={groups.notAffected}
        hostProductId="p-billing"
        hostName="Billing"
      />,
    );
    expect(screen.getByTestId("portfolio-impact-host")).toHaveTextContent("Built by: Billing");
    const badges = screen.getAllByTestId("portfolio-impact-host-badge");
    expect(badges).toHaveLength(1);
    expect(
      badges[0].closest("[data-testid=portfolio-affected-product]")!.querySelector("h3"),
    ).toHaveTextContent("Billing");
  });
});

describe("the check page", () => {
  it("says impact needs a host and links to the picker, instead of 'No product needs to change'", async () => {
    api.get.mockResolvedValue(nothingCovers());
    const { container } = render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    const note = await screen.findByTestId("portfolio-impact-needs-host");
    expect(note).toHaveTextContent("Impact needs a host product");
    expect(screen.queryByTestId("portfolio-impact-none")).toBeNull();
    expect(
      within(note).getByRole("link", { name: "choose the product that will build it" }),
    ).toHaveAttribute("href", hostPickerHref(nothingCovers()));
    expect(await axeViolations(container)).toEqual([]);
  });

  it("still says no product needs to change when one covers it already", async () => {
    api.get.mockResolvedValue(
      nothingCovers({
        verdict: "implemented",
        products: [product("p-orders", "covers"), product("p-billing", "not-covered")],
      }),
    );
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-impact-none")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-impact-needs-host")).toBeNull();
  });

  it("names the host under the requirement and in the impact", async () => {
    api.get.mockResolvedValue(
      nothingCovers({
        hostProductId: "p-orders",
        products: [
          product("p-orders", "not-covered", {}, { impactKind: "direct-change" }),
          product("p-billing", "not-covered"),
        ],
      }),
    );
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-detail-host")).toHaveTextContent(
      "Product that will build it: Orders",
    );
    expect(screen.getByTestId("portfolio-impact-host")).toHaveTextContent("Built by: Orders");
    expect(screen.queryByTestId("portfolio-impact-needs-host")).toBeNull();
  });
});

describe("the entry page", () => {
  it("starts from a statement in the link, and sends the host chosen", async () => {
    const user = userEvent.setup();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ statement: "Add a phone field" }) as never,
    );
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: "pa-new" });
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(screen.getByLabelText("Requirement statement")).toHaveValue("Add a phone field");
    const host = screen.getByLabelText("Which product will build this? (optional)");
    await waitFor(() => expect(within(host).getByRole("option", { name: "Orders" })).toBeVisible());
    await user.selectOptions(host, "p-orders");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        statement: "Add a phone field",
        scope: "all-accessible",
        hostProductId: "p-orders",
      }),
    );
  });
});
