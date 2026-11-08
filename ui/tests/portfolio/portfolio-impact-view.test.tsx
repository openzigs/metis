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

  it("#1963 — names every edge kind that connects the products, the shown path's first", () => {
    const v = impactView();
    const ledger = v.products.find((p) => p.productId === "p-ledger")!;
    const detail = ledger.technicalDetail as { impact: Record<string, unknown> };
    detail.impact = {
      ...detail.impact,
      links: [
        { integrationKind: "api" },
        { integrationKind: "database" },
        { integrationKind: "event" },
      ],
    };
    renderView(v);
    expect(within(card("Ledger")).getByTestId("portfolio-impact-via")).toHaveTextContent(
      "via an API, also an event, a shared database",
    );
    // A product reached by one kind only says that one.
    expect(within(card("Warehouse")).getByTestId("portfolio-impact-via")).toHaveTextContent(
      /^via a shared database$/,
    );
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
      "Billing → Ledger: contract coupling starts at low; +1 step because the provider's latest contract version made a breaking change, so medium. Confidence 0.9.",
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
    // #1673 — grouped by kind, so the heading says what it is: no "(table)".
    expect(wdive).toHaveTextContent("Tables and columnspayments");
    expect(wdive).not.toHaveTextContent("payments (table)");
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

  it("#1673 — says a product the walk could not rule out is restricted, not affected or not", () => {
    const v = impactView();
    v.products[1] = {
      ...v.products[1],
      impactKind: "restricted",
      technicalDetail: {
        ...v.products[1].technicalDetail,
        impact: { stoppedAtRestricted: 1, restrictedRule: "walk", hops: [] },
      },
    };
    renderView(v);
    const crm = card("CRM");
    expect(within(crm).getByTestId("portfolio-impact-kind")).toHaveTextContent("Restricted");
    expect(within(crm).getByTestId("portfolio-impact-unknown")).toHaveTextContent(
      "The change may reach it through a repository or product that the person who ran the check cannot read, so the check could not follow it there, and whether the change reaches this one is not known.",
    );
    expect(within(crm).queryByRole("button", { name: "Why this severity?" })).toBeNull();
  });

  it("#1689 — a row stored under the older connection rule claims a connection, not a path", () => {
    const v = impactView();
    v.products[1] = {
      ...v.products[1],
      impactKind: "restricted",
      technicalDetail: {
        ...v.products[1].technicalDetail,
        impact: { stoppedAtRestricted: 1, restrictedRule: "adjacent", hops: [] },
      },
    };
    renderView(v);
    const note = within(card("CRM")).getByTestId("portfolio-impact-unknown");
    expect(note).toHaveTextContent(
      "The check stopped at a product the person who ran it cannot read, and this one is connected to it, so whether the change reaches this one is not known. The check ran under an older rule for such connections: run it again for a more exact answer.",
    );
    expect(note).not.toHaveTextContent("may reach it through");
  });

  it("#1689 — under the older rule, the not-affected group says it may have missed one", () => {
    const olderRule =
      "This check ran under an older rule for products it could not follow, so a product listed as not affected may still be reached through a repository or product that the person who ran it cannot read. Run the check again to find out.";
    const v = impactView();
    const crm = v.products.findIndex((p) => p.impactKind === "none");
    v.products[crm] = {
      ...v.products[crm],
      technicalDetail: {
        ...v.products[crm].technicalDetail,
        impact: { stoppedAtRestricted: 1, restrictedRule: "adjacent", hops: [] },
      },
    };
    const { unmount } = renderView(v);
    expect(screen.getByTestId("portfolio-not-affected-older-rule")).toHaveTextContent(olderRule);
    unmount();
    // #1695 — no rule: a run before #1692 that stopped nowhere. It missed paths
    // through what its starter could not read, so it says so too.
    delete (v.products[crm].technicalDetail as { impact: Record<string, unknown> }).impact
      .restrictedRule;
    delete (v.products[crm].technicalDetail as { impact: Record<string, unknown> }).impact
      .stoppedAtRestricted;
    const noRule = renderView(v);
    expect(screen.getByTestId("portfolio-not-affected-older-rule")).toHaveTextContent(olderRule);
    noRule.unmount();
    // Under the current rule, a `none` is the walk's answer: no hint.
    (v.products[crm].technicalDetail as { impact: Record<string, unknown> }).impact.restrictedRule =
      "walk";
    renderView(v);
    expect(screen.queryByTestId("portfolio-not-affected-older-rule")).toBeNull();
  });

  it("#1685 — a row stored before #1680 does not claim a connection it never looked for", () => {
    const v = impactView();
    v.products[1] = {
      ...v.products[1],
      impactKind: "restricted",
      technicalDetail: {
        ...v.products[1].technicalDetail,
        impact: { stoppedAtRestricted: 1, hops: [] },
      },
    };
    renderView(v);
    const note = within(card("CRM")).getByTestId("portfolio-impact-unknown");
    expect(note).toHaveTextContent(
      "The check stopped at a product the person who ran it cannot read, so whether the change reaches this one is not known. The check ran before METIS looked for a connection to that product: run it again to find out whether there is one.",
    );
    expect(note).not.toHaveTextContent("may reach it through");
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
    render(
      <PortfolioImpactView
        affected={[]}
        notAffected={[{ productId: "p-x", name: null, olderRule: false }]}
      />,
    );
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
    // #1673 — the arrow's label is the accessible name's words, not the stored kind.
    expect(texts).toEqual(["A very long produ…", "shared identity", "A product you can…"]);
    // It keeps its own width, so a narrow screen scrolls it rather than shrinking it.
    expect(svg).not.toHaveClass("max-w-full");
    expect(svg).toHaveAttribute("width", String(svg.getAttribute("viewBox")!.split(" ")[2]));
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
