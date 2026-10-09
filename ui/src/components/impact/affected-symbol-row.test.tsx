/**
 * #992 — an impacted symbol links to its file:line on the project's GitHub repo,
 * so a developer can open the function the impact analysis named. With no repo
 * (or an unsafe path) it stays plain text.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ImpactAffectedSymbolView, ImpactItemView } from "@metis/shared";
import type { CodeCitationRepo } from "@/lib/code-citation-blob-url";
import { AffectedSymbolRow } from "./affected-symbol-row";
import { ChangedRequirementGroup } from "./changed-requirement-group";
import { ImpactSymbolRepoContext } from "./impact-symbol-repo-context";

const REPO: CodeCitationRepo = {
  origin: "https://github.com",
  owner: "acme",
  repo: "shop",
  ref: "abc1234",
};

function symbol(over: Partial<ImpactAffectedSymbolView> = {}): ImpactAffectedSymbolView {
  return {
    id: "s1",
    codeSymbolId: "cs1",
    filePath: "src/orders/service.ts",
    qualifiedName: "OrderService.place",
    startLine: 10,
    endLine: 42,
    relation: "direct",
    depth: 0,
    confidence: 0.9,
    ...over,
  };
}

function renderRow(sym: ImpactAffectedSymbolView, repo?: CodeCitationRepo | null) {
  return render(
    <ul>
      <AffectedSymbolRow symbol={sym} repo={repo} />
    </ul>,
  );
}

describe("AffectedSymbolRow symbol link (#992)", () => {
  it("links the symbol to file:line at the repo's commit, in a new tab", () => {
    renderRow(symbol(), REPO);
    const link = screen.getByTestId("affected-symbol-link");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/shop/blob/abc1234/src/orders/service.ts#L10-L42",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("OrderService.place");
    expect(link.getAttribute("title")).toContain("src/orders/service.ts:10-42");
  });

  it("links to the file without a line anchor when the symbol has no line range", () => {
    renderRow(symbol({ startLine: null, endLine: null }), REPO);
    expect(screen.getByTestId("affected-symbol-link")).toHaveAttribute(
      "href",
      "https://github.com/acme/shop/blob/abc1234/src/orders/service.ts",
    );
  });

  it("stays plain text when no repo is known", () => {
    renderRow(symbol(), null);
    expect(screen.queryByTestId("affected-symbol-link")).not.toBeInTheDocument();
    expect(screen.getByText("OrderService.place")).toBeInTheDocument();
  });

  it("stays plain text for an unsafe path", () => {
    renderRow(symbol({ filePath: "../../etc/passwd" }), REPO);
    expect(screen.queryByTestId("affected-symbol-link")).not.toBeInTheDocument();
  });
});

function item(projectId: string): ImpactItemView {
  return {
    id: "it-1",
    projectId,
    requirementId: "r1",
    requirementTitle: "Req",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.5,
    confidence: 0.8,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 3,
    affectedSymbolCount: 3,
    summary: null,
    affectedSymbols: [
      symbol(),
      symbol({ id: "s2", qualifiedName: "Cart.checkout", relation: "caller", depth: 1 }),
    ],
    affectedTests: [
      symbol({ id: "s3", filePath: "src/orders/service.test.ts", qualifiedName: "placeTest" }),
    ],
    writePathGaps: [],
    affectedTables: [],
    affectedTablesSecondary: [],
    feedback: [],
  };
}

describe("ChangedRequirementGroup symbol links (#992)", () => {
  it("links direct, blast-radius and test symbols using the item's project repo", () => {
    render(
      <ImpactSymbolRepoContext.Provider value={{ p1: REPO, p2: null }}>
        <ChangedRequirementGroup item={item("p1")} />
      </ImpactSymbolRepoContext.Provider>,
    );
    const links = screen.getAllByTestId("affected-symbol-link");
    expect(links.map((l) => l.textContent)).toEqual([
      "OrderService.place",
      "Cart.checkout",
      "placeTest",
    ]);
  });

  it("does not borrow another project's repo", () => {
    render(
      <ImpactSymbolRepoContext.Provider value={{ p1: REPO }}>
        <ChangedRequirementGroup item={item("p2")} />
      </ImpactSymbolRepoContext.Provider>,
    );
    expect(screen.queryByTestId("affected-symbol-link")).not.toBeInTheDocument();
  });

  it("renders plain text with no provider", () => {
    render(<ChangedRequirementGroup item={item("p1")} />);
    expect(screen.queryByTestId("affected-symbol-link")).not.toBeInTheDocument();
  });
});
