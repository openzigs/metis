/**
 * #1627 — the impact view: each affected product's kind, via, severity badge
 * and paragraph; "Why this severity?" discloses the stored derivation; the
 * deep dive lists repos, files, contract items, tables, topics and draws the
 * path; "Not affected" is a collapsed group. Keyboard operable; axe passes.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { impactGroups } from "@/lib/portfolio-impact";
import { PortfolioImpactView } from "@/components/portfolio/portfolio-impact-view";
import { PortfolioBaSummary } from "@/components/portfolio/portfolio-ba-summary";
import { PortfolioPathDiagram } from "@/components/portfolio/portfolio-path-diagram";
import { impactView } from "./impact-fixtures";
import { axeViolations } from "./axe";

function renderView(v = impactView()) {
  const groups = impactGroups(v);
  return render(
    <PortfolioImpactView affected={groups.affected} notAffected={groups.notAffected} />,
  );
}

function card(name: string) {
  return screen
    .getAllByTestId("portfolio-affected-product")
    .find((c) => within(c).getAllByRole("heading")[0].textContent === name)!;
}

describe("PortfolioImpactView", () => {
  it("shows each affected product's kind, via, severity and paragraph", () => {
    renderView();
    const ledger = card("Ledger");
    expect(within(ledger).getByTestId("portfolio-impact-kind")).toHaveTextContent(
      "Downstream consumer",
    );
    expect(ledger).toHaveTextContent("via an API");
    expect(within(ledger).getByTestId("portfolio-severity")).toHaveTextContent("Severity: medium");
    expect(ledger).toHaveTextContent("Ledger must accept the new invoice field.");

    const billing = card("Billing");
    expect(within(billing).getByTestId("portfolio-impact-kind")).toHaveTextContent("Must change");
    expect(within(billing).queryByTestId("portfolio-severity")).toBeNull();
    expect(within(billing).queryByRole("button", { name: "Why this severity?" })).toBeNull();
  });

  it("discloses the stored derivation on 'Why this severity?'", async () => {
    const user = userEvent.setup();
    renderView();
    const warehouse = card("Warehouse");
    const why = within(warehouse).getByRole("button", { name: "Why this severity?" });
    expect(why).toHaveAttribute("aria-expanded", "false");
    expect(within(warehouse).queryByTestId("portfolio-severity-why")).toBeNull();
    await user.click(why);
    expect(why).toHaveAttribute("aria-expanded", "true");
    const panel = within(warehouse).getByTestId("portfolio-severity-why");
    expect(why).toHaveAttribute("aria-controls", panel.id);
    const steps = within(panel)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(steps).toEqual([
      "Billing → Ledger: contract coupling starts at low; +1 step for a breaking contract change, so medium. Confidence 0.9.",
      "Ledger → Warehouse: intrusive coupling starts at high; −1 step for low confidence (0.4), so medium. Confidence 0.4.",
    ]);
    expect(panel).toHaveTextContent("Overall: medium. A path is as severe as its weakest hop.");
  });

  it("opens a deep dive listing repos, files, contract items, tables, topics and the path", async () => {
    const user = userEvent.setup();
    renderView();
    const ledger = card("Ledger");
    await user.click(within(ledger).getByRole("button", { name: "Technical deep dive" }));
    const dive = within(ledger).getByTestId("portfolio-deep-dive");
    expect(dive).toHaveTextContent("acme/p-ledger (consumer)");
    expect(dive).toHaveTextContent("acme/p-ledger · src/client/billing.ts:88 (call site)");
    expect(dive).toHaveTextContent("Contract items (version 4)");
    expect(dive).toHaveTextContent("POST /invoices: field `iban` added as required, breaking");
    expect(
      within(dive).getByRole("img", { name: "Path: Billing, then an API to Ledger" }),
    ).toBeVisible();

    const warehouse = card("Warehouse");
    await user.click(within(warehouse).getByRole("button", { name: "Technical deep dive" }));
    const wdive = within(warehouse).getByTestId("portfolio-deep-dive");
    expect(wdive).toHaveTextContent("Tables and columns");
    expect(wdive).toHaveTextContent("payments (table)");
    expect(wdive).toHaveTextContent("public.ledger_entries (table, used)");
    expect(wdive).toHaveTextContent(
      "2 links out of this product touch a repository you cannot read",
    );
    expect(
      within(wdive).getByRole("img", {
        name: "Path: Billing, then an API to Ledger, then a shared database to Warehouse",
      }),
    ).toBeVisible();

    const events = card("Events");
    await user.click(within(events).getByRole("button", { name: "Technical deep dive" }));
    expect(within(events).getByTestId("portfolio-deep-dive")).toHaveTextContent(
      "Topicsinvoice.paid",
    );

    const billing = card("Billing");
    await user.click(within(billing).getByRole("button", { name: "Technical deep dive" }));
    const bdive = within(billing).getByTestId("portfolio-deep-dive");
    expect(bdive).toHaveTextContent("acme/payments (partial)");
    expect(bdive).toHaveTextContent("acme/payments · src/transfer.ts:42");
    expect(within(bdive).queryByRole("img")).toBeNull();
  });

  it("says one hidden link in the singular", async () => {
    const user = userEvent.setup();
    const v = impactView();
    (v.products[3].technicalDetail.impact as { hiddenEdgeCount: number }).hiddenEdgeCount = 1;
    renderView(v);
    const warehouse = card("Warehouse");
    await user.click(within(warehouse).getByRole("button", { name: "Technical deep dive" }));
    expect(warehouse).toHaveTextContent(
      "1 link out of this product touches a repository you cannot read, so it was not followed.",
    );
  });

  it("shows a restricted product's impact kind and nothing else", () => {
    renderView();
    const restricted = card("A product you cannot read");
    expect(within(restricted).getByTestId("portfolio-impact-kind")).toHaveTextContent(
      "Downstream consumer",
    );
    expect(within(restricted).queryAllByRole("button")).toHaveLength(0);
  });

  it("says when a path was withheld", () => {
    const v = impactView();
    v.products[2] = { ...v.products[2], technicalDetail: { impactWithheld: true } };
    renderView(v);
    expect(card("Ledger")).toHaveTextContent(
      "Its impact path goes through a repository or product you cannot read",
    );
  });

  it("lists the products not affected in a collapsed group", async () => {
    const user = userEvent.setup();
    renderView();
    const group = screen.getByTestId("portfolio-not-affected");
    const toggle = within(group).getByRole("button", { name: "Not affected (2)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(group).queryAllByTestId("portfolio-not-affected-product")).toHaveLength(0);
    await user.click(toggle);
    expect(
      within(group)
        .getAllByTestId("portfolio-not-affected-product")
        .map((li) => li.textContent),
    ).toEqual(["CRM", "HR"]);
  });

  it("names a restricted product not affected without its name", async () => {
    const user = userEvent.setup();
    render(<PortfolioImpactView affected={[]} notAffected={[{ productId: "p-x", name: null }]} />);
    expect(screen.getByTestId("portfolio-impact-none")).toHaveTextContent(
      "No product needs to change",
    );
    await user.click(screen.getByRole("button", { name: "Not affected (1)" }));
    expect(screen.getByTestId("portfolio-not-affected-product")).toHaveTextContent(
      "A product you cannot read",
    );
  });

  it("is keyboard operable", async () => {
    const user = userEvent.setup();
    renderView();
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Technical deep dive");
    await user.keyboard("{Enter}");
    expect(screen.getAllByTestId("portfolio-deep-dive")).toHaveLength(1);
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Why this severity?");
    await user.keyboard(" ");
    expect(screen.getAllByTestId("portfolio-severity-why")).toHaveLength(1);
  });

  it("passes axe, collapsed and with everything open", async () => {
    const user = userEvent.setup();
    const { container } = renderView();
    expect(await axeViolations(container)).toEqual([]);
    for (const b of screen.getAllByRole("button")) await user.click(b);
    expect(screen.getAllByTestId("portfolio-path-diagram").length).toBeGreaterThan(1);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("PortfolioPathDiagram", () => {
  it("draws nothing for a path of one product", () => {
    const { container } = render(
      <PortfolioPathDiagram path={[{ productId: "a", name: "A" }]} edges={[]} />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws one box per product and one labelled arrow per hop, shortening long names", () => {
    render(
      <PortfolioPathDiagram
        path={[
          { productId: "a", name: "A very long product name indeed" },
          { productId: "b", name: null },
        ]}
        edges={["identity"]}
      />,
    );
    const svg = screen.getByRole("img", {
      name: "Path: A very long product name indeed, then shared identity to A product you cannot read",
    });
    expect(svg.querySelectorAll("rect")).toHaveLength(2);
    expect(svg.querySelectorAll("line")).toHaveLength(1);
    const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toEqual(["A very long produ…", "identity", "A product you can…"]);
  });
});

describe("PortfolioPathDiagram ids", () => {
  it("gives each diagram's arrow marker its own id, and its arrows point at it", () => {
    const path = [
      { productId: "a", name: "A" },
      { productId: "b", name: "B" },
    ];
    const { container } = render(
      <>
        <PortfolioPathDiagram path={path} edges={["api"]} />
        <PortfolioPathDiagram path={path} edges={["api"]} />
      </>,
    );
    const ids = [...container.querySelectorAll("marker")].map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const refs = [...container.querySelectorAll("line")].map((l) => l.getAttribute("marker-end"));
    expect(refs).toEqual(ids.map((id) => `url(#${id})`));
  });
});

describe("PortfolioBaSummary", () => {
  it("renders the summary's paragraphs", () => {
    render(<PortfolioBaSummary view={impactView()} />);
    const section = screen.getByTestId("portfolio-ba-summary");
    expect(within(section).getByRole("heading", { name: "Summary" })).toBeVisible();
    expect([...section.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "Billing partly covers this.",
      "Billing must change; Ledger and Warehouse consume what changes.",
    ]);
  });

  it("says when it is the template, and why", () => {
    const v = impactView();
    v.report = { ...v.report!, degraded: true, degradedReason: "model-offline" };
    render(<PortfolioBaSummary view={v} />);
    expect(screen.getByTestId("portfolio-summary-degraded")).toHaveTextContent(
      "Written from a template because the model is offline.",
    );
  });

  it("falls back to a generic reason for an unknown one", () => {
    const v = impactView();
    v.report = { ...v.report!, degraded: true, degradedReason: null };
    render(<PortfolioBaSummary view={v} />);
    expect(screen.getByTestId("portfolio-summary-degraded")).toHaveTextContent(
      "because the model could not write it",
    );
  });

  it("says when part of it is hidden from the reader", () => {
    const v = impactView();
    v.report = { ...v.report!, withheld: true };
    render(<PortfolioBaSummary view={v} />);
    expect(screen.getByTestId("portfolio-summary-withheld")).toBeVisible();
  });

  it("renders nothing without a summary", () => {
    const v = impactView();
    v.summary = "  ";
    const { container } = render(<PortfolioBaSummary view={v} />);
    expect(container).toBeEmptyDOMElement();
  });
});
